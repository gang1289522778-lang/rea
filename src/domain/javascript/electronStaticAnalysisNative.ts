import type { JavaScriptModuleResolutionMode } from "./javascriptModuleResolutionMode.js";
import * as t from "@babel/types";

import {
  compareUnicodeCodePoints,
  compositeKey,
} from "../unicodeCodePointOrder.js";
import { stripQueryAndFragment } from "../artifactPathSyntax.js";
import type { ElectronNativeAddonBindingFinding } from "./electronStaticAnalysisTypes.js";
import { addLocatedFinding } from "./javascriptStaticAnalysisFindings.js";
import {
  argumentNode,
  calleeName,
  range,
  stringValue,
} from "./javascriptStaticAnalysisHelpers.js";
import {
  propertyName,
  semanticStaticPropertyKey,
} from "./javascriptAstValues.js";
import type { JavaScriptFindingContext } from "./javascriptStaticAnalysisState.js";
import {
  typescriptImportTypeRequest,
  typescriptImportEqualsRequest,
} from "./typescriptImportResolutionMode.js";
import {
  isTypeOnlyImportDeclaration,
  isTypeOnlyImportSpecifier,
  isTypeOnlyExportDeclaration,
  isTypeOnlyExportSpecifier,
} from "./javascriptModuleDeclaration.js";

interface NativeBindingInput {
  readonly context: JavaScriptFindingContext;
  readonly node: t.Node;
  readonly specifier: string;
  readonly kind: ElectronNativeAddonBindingFinding["binding_kind"];
  readonly moduleKind: ElectronNativeAddonBindingFinding["module_kind"];
  readonly members: readonly string[];
  readonly namespaceAccess: boolean;
  readonly dynamicMemberAccess: boolean;
  readonly typeOnly?: boolean;
}

/** Inspect JavaScript-side imports and re-exports of native .node addons. */
export const inspectElectronNativeNode = (
  node: t.Node,
  context: JavaScriptFindingContext,
  resolutionMode: JavaScriptModuleResolutionMode = "import",
): void => {
  if (t.isImportDeclaration(node) || t.isExportNamedDeclaration(node))
    inspectDeclaration(node, context, resolutionMode);
  else if (t.isExportAllDeclaration(node))
    inspectExportAll(node, context, resolutionMode);
  else if (t.isTSImportType(node))
    inspectTypeImport(node, context, resolutionMode);
  else if (t.isTSImportEqualsDeclaration(node)) {
    const request = typescriptImportEqualsRequest(node, context.parentsByNode);
    if (
      request !== null &&
      isNativeSpecifier(request.specifier, request.resolutionMode)
    )
      addBinding({
        context,
        node: request.locationNode,
        specifier: request.specifier,
        kind: request.exportedName === null ? "require" : "re-export",
        moduleKind: request.resolutionMode,
        typeOnly: request.typeOnly,
        members: [],
        namespaceAccess: true,
        dynamicMemberAccess: false,
      });
  } else if (t.isVariableDeclarator(node)) inspectRequireBinding(node, context);
  else if (t.isAssignmentExpression(node)) inspectReExport(node, context);
};

const inspectTypeImport = (
  node: t.TSImportType,
  context: JavaScriptFindingContext,
  moduleKind: JavaScriptModuleResolutionMode,
): void => {
  const request = typescriptImportTypeRequest(node, context.parentsByNode);
  if (request === null || !isNativeSpecifier(request.specifier, moduleKind))
    return;
  const members = request.selection[0] ?? [];
  addBinding({
    context,
    node: request.locationNode,
    specifier: request.specifier,
    kind: "import",
    moduleKind,
    typeOnly: true,
    members,
    namespaceAccess:
      request.selection.length === 0 && !request.dynamicMemberAccess,
    dynamicMemberAccess: request.dynamicMemberAccess,
  });
};

const inspectDeclaration = (
  node: t.ImportDeclaration | t.ExportNamedDeclaration,
  context: JavaScriptFindingContext,
  moduleKind: JavaScriptModuleResolutionMode,
): void => {
  if (node.source == null || !isNativeSpecifier(node.source.value, moduleKind))
    return;
  const declarationTypeOnly = t.isImportDeclaration(node)
    ? isTypeOnlyImportDeclaration(node)
    : isTypeOnlyExportDeclaration(node);
  for (const typeOnly of [false, true]) {
    const specifiers = node.specifiers.filter(
      (specifier) =>
        (declarationTypeOnly ||
          (t.isImportSpecifier(specifier) &&
            isTypeOnlyImportSpecifier(specifier)) ||
          (t.isExportSpecifier(specifier) &&
            isTypeOnlyExportSpecifier(specifier))) === typeOnly,
    );
    if (
      specifiers.length === 0 &&
      (node.specifiers.length > 0 || typeOnly !== declarationTypeOnly)
    )
      continue;
    const members = specifiers.flatMap((specifier) => {
      if (
        t.isImportDefaultSpecifier(specifier) ||
        t.isExportDefaultSpecifier(specifier)
      )
        return ["default"];
      if (t.isImportSpecifier(specifier))
        return [propertyName(specifier.imported)];
      if (t.isExportSpecifier(specifier))
        return [propertyName(specifier.local)];
      return [];
    });
    addBinding({
      context,
      node,
      specifier: node.source.value,
      kind: t.isImportDeclaration(node) ? "import" : "re-export",
      moduleKind,
      typeOnly,
      members,
      namespaceAccess: specifiers.some(
        (specifier) =>
          t.isImportNamespaceSpecifier(specifier) ||
          t.isExportNamespaceSpecifier(specifier),
      ),
      dynamicMemberAccess: false,
    });
  }
};

const inspectExportAll = (
  node: t.ExportAllDeclaration,
  context: JavaScriptFindingContext,
  moduleKind: JavaScriptModuleResolutionMode,
): void => {
  if (
    node.source === undefined ||
    !isNativeSpecifier(node.source.value, moduleKind)
  )
    return;
  addBinding({
    context,
    node,
    specifier: node.source.value,
    kind: "re-export",
    moduleKind,
    typeOnly: isTypeOnlyExportDeclaration(node),
    members: [],
    namespaceAccess: true,
    dynamicMemberAccess: false,
  });
};

const inspectRequireBinding = (
  node: t.VariableDeclarator,
  context: JavaScriptFindingContext,
): void => {
  const required = nativeRequire(node.init);
  if (required === undefined) return;
  addBinding({
    context,
    node,
    specifier: required.specifier,
    kind: "require",
    moduleKind: "require",
    ...(required.hasMemberAccess ? required.access : bindingMembers(node.id)),
  });
};

const inspectReExport = (
  node: t.AssignmentExpression,
  context: JavaScriptFindingContext,
): void => {
  const required = nativeRequire(node.right);
  if (required === undefined || !isModuleExport(node.left)) return;
  addBinding({
    context,
    node,
    specifier: required.specifier,
    kind: "re-export",
    moduleKind: "require",
    ...required.access,
  });
};

const addBinding = (input: NativeBindingInput): void => {
  const { context, node, specifier, kind } = input;
  const members = [...new Set(input.members)].sort(compareUnicodeCodePoints);
  addLocatedFinding(context, {
    collection: context.accumulator.nativeAddonBindings,
    // Members are a variable-length source-derived list: compositeKey keeps
    // ["a\0b"] distinct from ["a", "b"] instead of collapsing one binding.
    key: compositeKey([
      "native-addon-binding",
      kind,
      specifier,
      input.moduleKind,
      input.typeOnly ?? false,
      members,
      input.namespaceAccess,
      input.dynamicMemberAccess,
    ]),
    node,
    value: {
      specifier,
      binding_kind: kind,
      module_kind: input.moduleKind,
      type_only: input.typeOnly ?? false,
      members,
      namespace_access: input.namespaceAccess,
      dynamic_member_access: input.dynamicMemberAccess,
      module_key: null,
      location: range(node),
    },
  });
};

const nativeRequire = (
  node: t.Node | null | undefined,
):
  | {
      readonly specifier: string;
      readonly hasMemberAccess: boolean;
      readonly access: NativeMemberAccess;
    }
  | undefined => {
  let member: string | null = null;
  let hasMemberAccess = false;
  while (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    if (!t.isNode(node.object)) return undefined;
    const property = semanticStaticPropertyKey(node.property, node.computed);
    // Walking inward leaves the first member consumed from the addon itself.
    member = property;
    hasMemberAccess = true;
    node = node.object;
  }
  if (!t.isCallExpression(node)) return undefined;
  const name = calleeName(node.callee);
  if (
    name !== "require" &&
    !name.endsWith(".require") &&
    !name.includes("__webpack_require__")
  )
    return undefined;
  const specifier = stringValue(argumentNode(node.arguments[0]));
  return specifier !== undefined && isNativeSpecifier(specifier, "require")
    ? {
        specifier,
        hasMemberAccess,
        access: {
          members: member === null ? [] : [member],
          namespaceAccess: !hasMemberAccess,
          dynamicMemberAccess: hasMemberAccess && member === null,
        },
      }
    : undefined;
};

interface NativeMemberAccess {
  readonly members: readonly string[];
  readonly namespaceAccess: boolean;
  readonly dynamicMemberAccess: boolean;
}

const bindingMembers = (pattern: t.Node): NativeMemberAccess => {
  if (!t.isObjectPattern(pattern))
    return { members: [], namespaceAccess: true, dynamicMemberAccess: false };
  const members: string[] = [];
  let namespaceAccess = false;
  let dynamicMemberAccess = false;
  for (const property of pattern.properties) {
    if (t.isRestElement(property)) {
      namespaceAccess = true;
      continue;
    }
    const key = semanticStaticPropertyKey(property.key, property.computed);
    if (key === null) dynamicMemberAccess = true;
    else members.push(key);
  }
  return { members, namespaceAccess, dynamicMemberAccess };
};

const isModuleExport = (node: t.Node): boolean => {
  const keys: (string | null)[] = [];
  while (t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) {
    keys.unshift(semanticStaticPropertyKey(node.property, node.computed));
    node = node.object;
  }
  if (!t.isIdentifier(node)) return false;
  return node.name === "exports"
    ? keys.length > 0
    : node.name === "module" && keys[0] === "exports";
};

const isNativeSpecifier = (
  specifier: string,
  moduleKind: ElectronNativeAddonBindingFinding["module_kind"],
): boolean => {
  const path =
    moduleKind === "require" ? specifier : stripQueryAndFragment(specifier);
  return path.toLowerCase().endsWith(".node");
};
