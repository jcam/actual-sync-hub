module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow chaining multiple type assertions such as `as unknown as SomeType`."
    },
    schema: [],
    messages: {
      noDoubleAssertion:
        "Chained type assertions are not allowed. Narrow the value properly or introduce an explicit boundary parser."
    }
  },

  create(context) {
    function reportIfDoubleAssertion(node) {
      const expression = node.expression;
      if (!expression) {
        return;
      }

      if (expression.type === "TSAsExpression" || expression.type === "TSTypeAssertion") {
        context.report({
          node,
          messageId: "noDoubleAssertion"
        });
      }
    }

    return {
      TSAsExpression(node) {
        reportIfDoubleAssertion(node);
      },

      TSTypeAssertion(node) {
        reportIfDoubleAssertion(node);
      }
    };
  }
};
