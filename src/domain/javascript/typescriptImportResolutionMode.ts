import * as t from "@babel/types";
import {
  readExactJavaScriptLiteral,
  semanticStaticPropertyKey,
} from "./javascriptAstValues.js";

/** Literal external-module target for either value or erased import-equals syntax. */
export const typescriptImportEqualsRequest = (
  node: t.TSImportEqualsDeclaration,
  parents?: Pick<WeakMap<t.Node, t.Node>, "get">,
): {
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly resolutionMode: "require";
  readonly exportedName: string | null;
  readonly locationNode: t.Node;
} | null => {
  if (
    !t.isTSExternalModuleReference(node.moduleReference) ||
    !t.isStringLiteral(node.moduleReference.expression)
  )
    return null;
  const parent = parents?.get(node);
  const exported =
    t.isExportNamedDeclaration(parent) && parent.declaration === node
      ? parent
      : undefined;
  return {
    specifier: node.moduleReference.expression.value,
    typeOnly: node.importKind === "type",
    resolutionMode: "require",
    exportedName: exported === undefined ? null : node.id.name,
    locationNode: exported ?? node,
  };
};

/** Read only explicit type-reference attributes; never evaluate an options expression. */
export const typescriptImportResolutionMode = (
  node: t.Node,
): "import" | "require" | "compiler-dependent" | undefined => {
  if (t.isTSImportType(node)) {
    if (node.options === null || node.options === undefined) return undefined;
    const attributes = literalProperty(node.options, "with");
    return resolutionModeValue(literalProperty(attributes, "resolution-mode"));
  }
  if (
    !t.isImportDeclaration(node) &&
    !t.isExportNamedDeclaration(node) &&
    !t.isExportAllDeclaration(node)
  )
    return undefined;
  const kind = t.isImportDeclaration(node) ? node.importKind : node.exportKind;
  if (kind !== "type")
    return node.attributes?.some(
      (attribute) =>
        semanticStaticPropertyKey(attribute.key, false) === "resolution-mode",
    ) === true
      ? "compiler-dependent"
      : undefined;
  const attributes = node.attributes;
  if (attributes === null || attributes === undefined) return undefined;
  const attribute = attributes[0];
  return attributes.length === 1 &&
    attribute !== undefined &&
    semanticStaticPropertyKey(attribute.key, false) === "resolution-mode"
    ? resolutionModeValue(attribute.value)
    : "compiler-dependent";
};

const resolutionModeValue = (
  node: t.Node | undefined,
): "import" | "require" | "compiler-dependent" =>
  t.isStringLiteral(node) &&
  (node.value === "import" || node.value === "require")
    ? node.value
    : "compiler-dependent";

const literalProperty = (
  node: t.Node | null | undefined,
  key: string,
): t.Node | undefined => {
  if (!t.isObjectExpression(node) || node.properties.length !== 1)
    return undefined;
  const property = node.properties[0];
  return t.isObjectProperty(property) &&
    !property.computed &&
    !property.shorthand &&
    semanticStaticPropertyKey(property.key, false) === key
    ? property.value
    : undefined;
};

/** Literal source and type selection, including indexed access owned by enclosing AST nodes. */
export const typescriptImportTypeRequest = (
  node: t.TSImportType,
  parents?: Pick<WeakMap<t.Node, t.Node>, "get">,
): {
  readonly specifier: string;
  readonly selection: readonly (readonly string[])[];
  readonly dynamicMemberAccess: boolean;
  readonly locationNode: t.Node;
} | null => {
  if (!t.isStringLiteral(node.source)) return null;
  const names: string[] = [];
  let qualifier = node.qualifier;
  while (t.isTSQualifiedName(qualifier)) {
    names.unshift(qualifier.right.name);
    qualifier = qualifier.left;
  }
  if (t.isIdentifier(qualifier)) names.unshift(qualifier.name);
  const selection: string[][] = names.map((name) => [name]);
  let cursor: t.Node = node;
  let locationNode: t.Node = node;
  let dynamicMemberAccess = false;
  for (;;) {
    const parent: t.Node | undefined = parents?.get(cursor);
    if (
      (t.isTSParenthesizedType(parent) && parent.typeAnnotation === cursor) ||
      (t.isTSTypeQuery(parent) && parent.exprName === cursor)
    ) {
      cursor = parent;
      continue;
    }
    if (!t.isTSIndexedAccessType(parent) || parent.objectType !== cursor) break;
    locationNode = parent;
    const keys = literalTypeIndexKeys(parent.indexType);
    selection.push(keys.values);
    if (!keys.complete) dynamicMemberAccess = true;
    if (keys.values.length === 0) break;
    cursor = parent;
  }
  return {
    specifier: node.source.value,
    selection,
    dynamicMemberAccess,
    locationNode,
  };
};

/** Segment alternatives retain finite unions without allocating Cartesian paths. */
const literalTypeIndexKeys = (
  type: t.TSType,
): { readonly values: string[]; readonly complete: boolean } => {
  const pending = [type];
  const values = new Set<string>();
  let complete = true;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (t.isTSParenthesizedType(current)) pending.push(current.typeAnnotation);
    else if (t.isTSUnionType(current))
      for (let index = current.types.length - 1; index >= 0; index--) {
        const arm = current.types[index];
        if (arm !== undefined) pending.push(arm);
      }
    else {
      const literal = t.isTSLiteralType(current)
        ? readExactJavaScriptLiteral(current.literal)
        : undefined;
      if (
        literal?.found &&
        (typeof literal.value === "string" || typeof literal.value === "number")
      )
        values.add(String(literal.value));
      else complete = false;
    }
  }
  return { values: [...values], complete };
};
