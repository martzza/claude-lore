module.exports = {
  apps: [
    {
      name: "claude-lore-worker",
      script: "packages/worker/src/index.ts",
      interpreter: "bun",
      watch: false,
      restart_delay: 3000,
      env: {
        CLAUDE_LORE_PORT: "37778",
        NODE_ENV: "production",
      },
    },
  ],
};
