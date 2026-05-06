const fs = require("fs");
const path = require("path");
const Module = require("module");

const builtins = new Set(Module.builtinModules.flatMap(moduleName => [moduleName, `node:${moduleName}`]));
const packageCache = new Map();

function getPackageName(source) {
  if (source.startsWith("@")) {
    const parts = source.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }

  return source.split("/")[0];
}

function readPackageManifest(packagePath) {
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch {
    return null;
  }
}

function collectDependencyInfo(startDirectory) {
  if (packageCache.has(startDirectory)) {
    return packageCache.get(startDirectory);
  }

  const dependencyNames = new Set();
  const packageNames = new Set();
  const visitedDirectories = [];
  let currentDirectory = startDirectory;
  let foundPackage = false;

  while (true) {
    visitedDirectories.push(currentDirectory);

    const packagePath = path.join(currentDirectory, "package.json");
    const manifest = readPackageManifest(packagePath);
    if (manifest) {
      foundPackage = true;

      if (typeof manifest.name === "string" && manifest.name.length > 0) {
        packageNames.add(manifest.name);
      }

      for (const dependencyName of Object.keys(manifest.dependencies || {})) {
        dependencyNames.add(dependencyName);
      }
      for (const dependencyName of Object.keys(manifest.devDependencies || {})) {
        dependencyNames.add(dependencyName);
      }
      for (const dependencyName of Object.keys(manifest.peerDependencies || {})) {
        dependencyNames.add(dependencyName);
      }
      for (const dependencyName of Object.keys(manifest.optionalDependencies || {})) {
        dependencyNames.add(dependencyName);
      }

      if (Array.isArray(manifest.workspaces)) {
        break;
      }
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  const result = foundPackage ? { dependencyNames, packageNames } : null;

  for (const directory of visitedDirectories) {
    packageCache.set(directory, result);
  }

  return result;
}

function isExternalImport(source) {
  if (source.startsWith(".") || source.startsWith("#") || source.startsWith("virtual:")) {
    return false;
  }

  const packageName = getPackageName(source);
  if (packageName && builtins.has(packageName)) {
    return false;
  }

  return true;
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing packages that are not declared in the current workspace or root workspace package.json files."
    },
    schema: [],
    messages: {
      extraneous:
        "\"{{packageName}}\" is not listed in dependencies for this workspace or the repo root. Add it to the appropriate package.json."
    }
  },

  createOnce(context) {
    let dependencyInfo;

    function check(sourceNode) {
      if (!sourceNode || typeof sourceNode.value !== "string") {
        return;
      }

      const importSource = sourceNode.value;
      if (!isExternalImport(importSource)) {
        return;
      }

      const packageName = getPackageName(importSource);
      if (!packageName) {
        return;
      }

      if (dependencyInfo.packageNames.has(packageName)) {
        return;
      }

      if (!dependencyInfo.dependencyNames.has(packageName)) {
        context.report({
          node: sourceNode,
          messageId: "extraneous",
          data: { packageName }
        });
      }
    }

    return {
      before() {
        dependencyInfo = collectDependencyInfo(path.dirname(context.filename));
        if (!dependencyInfo) {
          return false;
        }
      },

      ImportDeclaration(node) {
        check(node.source);
      },

      ExportNamedDeclaration(node) {
        check(node.source);
      },

      ExportAllDeclaration(node) {
        check(node.source);
      },

      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments.length === 1 &&
          node.arguments[0].type === "Literal" &&
          typeof node.arguments[0].value === "string"
        ) {
          check(node.arguments[0]);
        }
      }
    };
  }
};
