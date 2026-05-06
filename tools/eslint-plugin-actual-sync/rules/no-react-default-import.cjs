module.exports = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow React.* member usage in favor of named React exports."
    },
    schema: [],
    messages: {
      useNamedExport:
        "Using the default React import is discouraged here. Use named React exports directly instead."
    }
  },

  createOnce(context) {
    function isReactDefaultReference(node) {
      if (node.type === "MemberExpression") {
        return node.object.type === "Identifier" && node.object.name === "React";
      }

      if (node.type === "TSQualifiedName") {
        return node.left.type === "Identifier" && node.left.name === "React";
      }

      return false;
    }

    return {
      MemberExpression(node) {
        if (isReactDefaultReference(node)) {
          context.report({
            node,
            messageId: "useNamedExport"
          });
        }
      },

      JSXMemberExpression(node) {
        if (node.object.type === "JSXIdentifier" && node.object.name === "React") {
          context.report({
            node,
            messageId: "useNamedExport"
          });
        }
      },

      TSQualifiedName(node) {
        if (isReactDefaultReference(node)) {
          context.report({
            node,
            messageId: "useNamedExport"
          });
        }
      }
    };
  }
};
