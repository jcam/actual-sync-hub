const { eslintCompatPlugin } = require("@oxlint/plugins");

module.exports = eslintCompatPlugin({
  meta: {
    name: "eslint-plugin-actual-sync"
  },
  rules: {
    "enforce-boundaries": require("./rules/enforce-boundaries.cjs"),
    "no-extraneous-dependencies": require("./rules/no-extraneous-dependencies.cjs"),
    "no-react-default-import": require("./rules/no-react-default-import.cjs")
  }
});
