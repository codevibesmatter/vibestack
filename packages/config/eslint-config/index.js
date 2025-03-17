/** @type {import("eslint").Linter.Config} */
module.exports = {
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:@typescript-eslint/recommended-requiring-type-checking",
    "plugin:import/recommended",
    "plugin:import/typescript",
    "prettier"
  ],
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    project: true,
    tsconfigRootDir: process.cwd()
  },
  rules: {
    // Strict type checking
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/explicit-function-return-type": "error",
    "@typescript-eslint/explicit-module-boundary-types": "error",
    "@typescript-eslint/no-unsafe-assignment": "error",
    "@typescript-eslint/no-unsafe-member-access": "error",
    "@typescript-eslint/no-unsafe-call": "error",
    "@typescript-eslint/no-unsafe-return": "error",
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": "error",
    "@typescript-eslint/await-thenable": "error",
    "@typescript-eslint/require-await": "error",
    "@typescript-eslint/no-unnecessary-type-assertion": "error",
    "@typescript-eslint/restrict-template-expressions": "error",
    "@typescript-eslint/unbound-method": "error",
    "@typescript-eslint/no-unused-vars": ["error", { 
      "argsIgnorePattern": "^_",
      "varsIgnorePattern": "^_"
    }],

    // Import rules
    "import/no-unresolved": "error",
    "import/no-cycle": "error",
    "import/no-unused-modules": "error",
    "import/no-deprecated": "error",
    "import/first": "error",
    "import/newline-after-import": "error",
    "import/no-duplicates": "error",

    // General rules
    "no-console": ["error", { "allow": ["warn", "error"] }],
    "no-return-await": "error",
    "require-await": "error"
  },
  settings: {
    "import/parsers": {
      "@typescript-eslint/parser": [".ts", ".tsx"]
    },
    "import/resolver": {
      "typescript": {
        "alwaysTryTypes": true
      }
    }
  },
  ignorePatterns: ["node_modules/", "dist/"]
}; 