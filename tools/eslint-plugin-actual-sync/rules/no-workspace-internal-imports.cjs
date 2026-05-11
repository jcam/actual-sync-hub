function getInternalWorkspaceImport(source) {
  if (typeof source !== "string" || !source.startsWith("@actual-sync/")) {
    return null;
  }

  const parts = source.split("/");
  if (parts.length < 4) {
    return null;
  }

  const internalSegment = parts[2];
  if (!["src", "dist", "generated", "internal"].includes(internalSegment)) {
    return null;
  }

  return {
    packageName: `${parts[0]}/${parts[1]}`,
    internalSegment
  };
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow deep imports into internal workspace package directories."
    },
    schema: [],
    messages: {
      noWorkspaceInternalImport:
        "Import \"{{packageName}}\" through its public entrypoint instead of reaching into its \"{{internalSegment}}\" internals."
    }
  },

  create(context) {
    function check(sourceNode) {
      if (!sourceNode || typeof sourceNode.value !== "string") {
        return;
      }

      const internalImport = getInternalWorkspaceImport(sourceNode.value);
      if (!internalImport) {
        return;
      }

      context.report({
        node: sourceNode,
        messageId: "noWorkspaceInternalImport",
        data: internalImport
      });
    }

    return {
      ImportDeclaration(node) {
        check(node.source);
      },

      ExportNamedDeclaration(node) {
        check(node.source);
      },

      ExportAllDeclaration(node) {
        check(node.source);
      },

      ImportExpression(node) {
        if (node.source.type === "Literal") {
          check(node.source);
        }
      },

      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments.length === 1 &&
          node.arguments[0].type === "Literal"
        ) {
          check(node.arguments[0]);
        }
      }
    };
  }
};
