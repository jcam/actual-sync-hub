const path = require("path");

function normalizeFilePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function isRouteFile(filePath) {
  const normalized = normalizeFilePath(filePath);
  return normalized.endsWith("/src/routes.ts") || normalized.includes("/src/routes/");
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct request.body/request.params/request.query access in route files so boundary parsing stays centralized."
    },
    schema: [],
    messages: {
      noDirectRequestBoundaryAccess:
        "Do not access `request.{{property}}` directly in route files. Use the request-parsing helpers so boundary validation stays explicit and consistent."
    }
  },

  create(context) {
    if (!isRouteFile(context.filename)) {
      return {};
    }

    return {
      MemberExpression(node) {
        if (
          node.object.type !== "Identifier" ||
          node.object.name !== "request" ||
          node.computed
        ) {
          return;
        }

        if (node.property.type !== "Identifier") {
          return;
        }

        if (!["body", "params", "query"].includes(node.property.name)) {
          return;
        }

        context.report({
          node,
          messageId: "noDirectRequestBoundaryAccess",
          data: {
            property: node.property.name
          }
        });
      }
    };
  }
};
