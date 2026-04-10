import Parser from "web-tree-sitter";
import { readFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ParsedSymbol {
  name:       string;
  kind:       SymbolKind;
  start_line: number;
  end_line:   number;
  exported:   boolean;
  is_test:    boolean;
  parent?:    string; // class name for methods
}

export interface ParsedCallSite {
  caller:    string;
  callee:    string;
  call_line: number;
  kind:      "calls" | "test_covers";
}

export interface ParsedFile {
  path:     string;
  symbols:  ParsedSymbol[];
  calls:    ParsedCallSite[];
  imports:  string[];
  language: Language;
}

export type SymbolKind =
  | "function" | "method" | "class" | "interface"
  | "type" | "const" | "arrow" | "test";

export type Language =
  | "typescript" | "javascript" | "tsx" | "jsx" | "unknown";

// ─── Language detection ───────────────────────────────────────────────────────

export function detectLanguage(filePath: string): Language {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":  return "typescript";
    case "tsx": return "tsx";
    case "js":  return "javascript";
    case "jsx": return "jsx";
    default:    return "unknown";
  }
}

// ─── Test detection ───────────────────────────────────────────────────────────

const TEST_FILE_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx)$/,
  /\.spec\.(ts|tsx|js|jsx)$/,
  /__tests__\//,
  /\/tests?\//,
];

const TEST_FUNCTION_NAMES = new Set([
  "it", "test", "describe", "beforeEach", "afterEach",
  "beforeAll", "afterAll", "expect", "suite", "spec",
]);

function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

// ─── Skip set for call extraction ────────────────────────────────────────────

const SKIP_CALLEES = new Set([
  "if", "for", "while", "switch", "catch", "return", "typeof",
  "instanceof", "console", "Object", "Array", "Promise", "JSON",
  "Math", "parseInt", "parseFloat", "String", "Number", "Boolean",
  "Error", "fetch", "setTimeout", "clearTimeout", "setInterval",
  "clearInterval", "require", "import", "export", "default",
  "async", "await", "new", "this", "super", "null", "undefined",
  "true", "false", "void", "never", "any", "unknown",
]);

// ─── WASM initialisation (singleton) ─────────────────────────────────────────

let _initPromise: Promise<void> | null = null;
let _tsLang:  Parser.Language | null = null;
let _jsLang:  Parser.Language | null = null;
let _tsxLang: Parser.Language | null = null;

function getWasmDir(): string {
  const req = createRequire(import.meta.url);
  const pkgDir = dirname(req.resolve("tree-sitter-wasms/package.json"));
  return join(pkgDir, "out");
}

async function ensureInit(): Promise<void> {
  if (_tsLang) return;
  if (!_initPromise) {
    _initPromise = (async () => {
      await Parser.init();
      const wasmDir = getWasmDir();
      const [tsWasm, jsWasm] = [
        readFileSync(join(wasmDir, "tree-sitter-typescript.wasm")),
        readFileSync(join(wasmDir, "tree-sitter-javascript.wasm")),
      ];
      _tsLang  = await Parser.Language.load(tsWasm);
      _tsxLang = _tsLang; // same grammar handles tsx
      _jsLang  = await Parser.Language.load(jsWasm);
    })();
  }
  await _initPromise;
}

function getLang(language: Language): Parser.Language | null {
  switch (language) {
    case "typescript":
    case "tsx":
      return _tsLang;
    case "javascript":
    case "jsx":
      return _jsLang;
    default:
      return null;
  }
}

// ─── Main parser ──────────────────────────────────────────────────────────────

export async function parseFile(filePath: string): Promise<ParsedFile | null> {
  const language = detectLanguage(filePath);
  if (language === "unknown") return null;

  await ensureInit();

  const grammar = getLang(language);
  if (!grammar) return null;

  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(source);

  const isTest = isTestFile(filePath);
  const symbols: ParsedSymbol[] = [];
  const calls:   ParsedCallSite[] = [];
  const imports: string[] = [];

  let currentClass: string | null = null;

  function walk(node: Parser.SyntaxNode, currentSymbol?: string, currentSymbolIsTest?: boolean): void {
    switch (node.type) {

      // Import declarations ─────────────────────────────────────────────────
      case "import_statement": {
        // Find the string literal source
        for (const child of node.children) {
          if (child.type === "string") {
            const raw = child.text.replace(/['"]/g, "");
            imports.push(raw);
          }
        }
        break;
      }

      // Export statement — recurse into the exported declaration ─────────────
      // We DON'T break here so that child walk picks up the inner declaration
      case "export_statement": {
        for (const child of node.children) {
          walk(child, currentSymbol);
        }
        return;
      }

      // Class declarations ──────────────────────────────────────────────────
      case "class_declaration":
      case "abstract_class_declaration": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const name = nameNode.text;
          currentClass = name;
          symbols.push({
            name,
            kind:       "class",
            start_line: node.startPosition.row + 1,
            end_line:   node.endPosition.row + 1,
            exported:   isExported(node),
            is_test:    false,
          });
          // Walk class body — class itself is not a test scope
          for (const child of node.children) walk(child, currentSymbol, currentSymbolIsTest);
          currentClass = null;
          return;
        }
        break;
      }

      // Function declarations ───────────────────────────────────────────────
      case "function_declaration":
      case "generator_function_declaration": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const name = nameNode.text;
          const isTestFn = isTest || TEST_FUNCTION_NAMES.has(name);
          symbols.push({
            name,
            kind:       isTestFn ? "test" : "function",
            start_line: node.startPosition.row + 1,
            end_line:   node.endPosition.row + 1,
            exported:   isExported(node),
            is_test:    isTestFn,
            parent:     currentClass ?? undefined,
          });
          for (const child of node.children) walk(child, name, isTestFn);
          return;
        }
        break;
      }

      // Method definitions ──────────────────────────────────────────────────
      case "method_definition": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          const name = nameNode.text;
          const isTestFn = isTest || TEST_FUNCTION_NAMES.has(name);
          symbols.push({
            name,
            kind:       isTestFn ? "test" : "method",
            start_line: node.startPosition.row + 1,
            end_line:   node.endPosition.row + 1,
            exported:   false,
            is_test:    isTestFn,
            parent:     currentClass ?? undefined,
          });
          for (const child of node.children) walk(child, name, isTestFn);
          return;
        }
        break;
      }

      // Variable declarations with arrow functions / function expressions ───
      case "lexical_declaration":
      case "variable_declaration": {
        for (const child of node.children) {
          if (child.type === "variable_declarator") {
            const nameNode = child.childForFieldName("name");
            const valueNode = child.childForFieldName("value");
            if (nameNode && valueNode &&
                (valueNode.type === "arrow_function" ||
                 valueNode.type === "function" ||
                 valueNode.type === "function_expression")) {
              const name = nameNode.text;
              const isTestFn = isTest || TEST_FUNCTION_NAMES.has(name);
              symbols.push({
                name,
                kind:       isTestFn ? "test" : "arrow",
                start_line: node.startPosition.row + 1,
                end_line:   node.endPosition.row + 1,
                exported:   isExported(node),
                is_test:    isTestFn,
                parent:     currentClass ?? undefined,
              });
              for (const c of valueNode.children) walk(c, name, isTestFn);
              return;
            }
          }
        }
        break;
      }

      // Interface declarations ──────────────────────────────────────────────
      case "interface_declaration": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          symbols.push({
            name:       nameNode.text,
            kind:       "interface",
            start_line: node.startPosition.row + 1,
            end_line:   node.endPosition.row + 1,
            exported:   isExported(node),
            is_test:    false,
          });
        }
        break;
      }

      // Type alias declarations ─────────────────────────────────────────────
      case "type_alias_declaration": {
        const nameNode = node.childForFieldName("name");
        if (nameNode) {
          symbols.push({
            name:       nameNode.text,
            kind:       "type",
            start_line: node.startPosition.row + 1,
            end_line:   node.endPosition.row + 1,
            exported:   isExported(node),
            is_test:    false,
          });
        }
        break;
      }

      // Call expressions — extract caller/callee ────────────────────────────
      case "call_expression": {
        if (currentSymbol) {
          const funcNode = node.childForFieldName("function");
          if (funcNode) {
            let calleeName: string | null = null;

            if (funcNode.type === "identifier") {
              calleeName = funcNode.text;
            } else if (funcNode.type === "member_expression") {
              const prop = funcNode.childForFieldName("property");
              if (prop) calleeName = prop.text;
            }

            if (
              calleeName &&
              !SKIP_CALLEES.has(calleeName) &&
              calleeName.length > 2 &&
              /^[a-zA-Z_$]/.test(calleeName)
            ) {
              // Edge kind: test_covers when the enclosing symbol is a test function
              const isTestCaller = currentSymbolIsTest ?? isTest;
              calls.push({
                caller:    currentSymbol,
                callee:    calleeName,
                call_line: node.startPosition.row + 1,
                kind:      isTestCaller ? "test_covers" : "calls",
              });
            }
          }
        }
        break;
      }
    }

    // Continue walking children
    for (const child of node.children) {
      walk(child, currentSymbol, currentSymbolIsTest);
    }
  }

  walk(tree.rootNode);

  return { path: filePath, symbols, calls, imports, language };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isExported(node: Parser.SyntaxNode): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "export_statement") return true;
    parent = parent.parent;
  }
  return false;
}
