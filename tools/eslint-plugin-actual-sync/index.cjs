const { eslintCompatPlugin } = require("@oxlint/plugins");

module.exports = eslintCompatPlugin({
  meta: {
    name: "eslint-plugin-actual-sync"
  },
  rules: {
    "enforce-boundaries": require("./rules/enforce-boundaries.cjs"),
    "no-direct-request-boundary-access": require("./rules/no-direct-request-boundary-access.cjs"),
    "no-extraneous-dependencies": require("./rules/no-extraneous-dependencies.cjs"),
    "no-test-helper-imports": require("./rules/no-test-helper-imports.cjs"),
    "no-react-default-import": require("./rules/no-react-default-import.cjs"),
    "no-double-type-assertion": require("./rules/no-double-type-assertion.cjs"),
    "no-raw-json-parse-assertion": require("./rules/no-raw-json-parse-assertion.cjs"),
    "no-workspace-internal-imports": require("./rules/no-workspace-internal-imports.cjs")
  }
});
