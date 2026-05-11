module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow asserting a type directly on the result of JSON.parse."
    },
    schema: [],
    messages: {
      noRawJsonParseAssertion:
        "Do not assert a type directly on `JSON.parse(...)`. Parse to `unknown` or a JSON helper first, then validate or narrow explicitly."
    }
  },

  create(context) {
    function isJsonParseCall(node) {
      return (
        node &&
        node.type === "CallExpression" &&
        node.callee &&
        node.callee.type === "MemberExpression" &&
        node.callee.object &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "JSON" &&
        !node.callee.computed &&
        node.callee.property &&
        node.callee.property.type === "Identifier" &&
        node.callee.property.name === "parse"
      );
    }

    function reportIfRawJsonParseAssertion(node) {
      if (isJsonParseCall(node.expression)) {
        context.report({
          node,
          messageId: "noRawJsonParseAssertion"
        });
      }
    }

    return {
      TSAsExpression(node) {
        reportIfRawJsonParseAssertion(node);
      },

      TSTypeAssertion(node) {
        reportIfRawJsonParseAssertion(node);
      }
    };
  }
};
