const path = require("path");

function normalizeFilePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isProductionSourceFile(filePath) {
  if (!filePath) {
    return false;
  }

  const normalized = normalizeFilePath(filePath);

  if (!normalized.includes("/src/")) {
    return false;
  }

  if (
    normalized.includes("/src/test/") ||
    normalized.includes("/src/integration/") ||
    normalized.includes("/src/generated/") ||
    normalized.includes("/src/dev/")
  ) {
    return false;
  }

  const baseName = normalized.split("/").pop() || "";
  return !/(\.test|\.spec)(\.[cm]?[jt]sx?)?$/.test(baseName);
}

function isTestHelperImport(source) {
  if (typeof source !== "string") {
    return false;
  }

  return (
    source.includes("/test/") ||
    source.startsWith("../test/") ||
    source.startsWith("./test/") ||
    /(^|\/)test-utils(\.[cm]?[jt]sx?)?$/.test(source) ||
    /\.(test|spec)(\.[cm]?[jt]sx?)?$/.test(source)
  );
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow importing test helpers from production source files."
    },
    schema: [],
    messages: {
      noTestHelperImport:
        "Production source files must not import test helpers like \"{{source}}\". Move the helper to a non-test module if it is shared runtime code."
    }
  },

  create(context) {
    const enforceForFile = isProductionSourceFile(context.filename);

    function check(sourceNode) {
      if (!enforceForFile || !sourceNode || typeof sourceNode.value !== "string") {
        return;
      }

      if (!isTestHelperImport(sourceNode.value)) {
        return;
      }

      context.report({
        node: sourceNode,
        messageId: "noTestHelperImport",
        data: {
          source: sourceNode.value
        }
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
