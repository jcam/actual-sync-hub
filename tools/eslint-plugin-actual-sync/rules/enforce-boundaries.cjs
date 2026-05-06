module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Enforce architectural boundaries by disallowing tsconfig paths, Vite resolve.alias, and deep backtracked imports."
    },
    schema: [],
    messages: {
      noTsconfigPaths:
        "tsconfig \"compilerOptions.paths\" is not allowed. Prefer workspace/package imports instead.",
      noResolveAlias:
        "Vite \"resolve.alias\" is not allowed. Prefer workspace/package imports instead.",
      noBacktrackedImport:
        "Backtracked import \"{{source}}\" is not allowed. Prefer workspace/package imports instead."
    }
  },

  create(context) {
    function getPropertyName(node) {
      if (!node || !node.key) {
        return null;
      }
      if (node.key.type === "Identifier") {
        return node.key.name;
      }
      if (node.key.type === "Literal") {
        return String(node.key.value);
      }
      return null;
    }

    function isBacktrackedImport(source) {
      return typeof source === "string" && source.startsWith("../../");
    }

    function reportBacktrackedImport(source) {
      if (!source || !isBacktrackedImport(source.value)) {
        return;
      }

      context.report({
        node: source,
        messageId: "noBacktrackedImport",
        data: { source: source.value }
      });
    }

    return {
      Property(node) {
        const name = getPropertyName(node);
        if (name !== "paths" && name !== "alias") {
          return;
        }

        const parentObject = node.parent;
        if (!parentObject || parentObject.type !== "ObjectExpression") {
          return;
        }

        const grandparent = parentObject.parent;
        if (!grandparent || grandparent.type !== "Property") {
          return;
        }

        const grandparentName = getPropertyName(grandparent);

        if (name === "paths" && grandparentName === "compilerOptions") {
          context.report({ node, messageId: "noTsconfigPaths" });
        }

        if (name === "alias" && grandparentName === "resolve") {
          context.report({ node, messageId: "noResolveAlias" });
        }
      },

      ImportDeclaration(node) {
        reportBacktrackedImport(node.source);
      },

      ExportNamedDeclaration(node) {
        reportBacktrackedImport(node.source);
      },

      ExportAllDeclaration(node) {
        reportBacktrackedImport(node.source);
      },

      ImportExpression(node) {
        if (node.source.type === "Literal") {
          reportBacktrackedImport(node.source);
        }
      },

      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments.length === 1 &&
          node.arguments[0].type === "Literal"
        ) {
          reportBacktrackedImport(node.arguments[0]);
        }
      }
    };
  }
};
