module.exports = {
  root: true,
  extends: ["@repo/eslint-config"],
  parserOptions: {
    tsconfigRootDir: __dirname,
    project: [
      "./apps/*/tsconfig.json",
      "./packages/*/tsconfig.json"
    ]
  }
}; 