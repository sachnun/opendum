const NAME_TYPES = new Set(["Identifier", "PrivateIdentifier"]);

export function identifierVisitor(handle, options = {}) {
  const ignoreDestructured = options.ignoreDestructured ?? true;

  const visitName = (node, kind) => {
    if (node && NAME_TYPES.has(node.type)) handle(node, kind);
  };

  const visitPattern = (node, kind) => {
    if (!node) return;
    if (node.type === "Identifier") {
      handle(node, kind);
      return;
    }
    if (ignoreDestructured) return;
    if (node.type === "ObjectPattern") {
      for (const property of node.properties) visitPattern(property.value ?? property.argument, kind);
      return;
    }
    if (node.type === "ArrayPattern") {
      for (const element of node.elements) visitPattern(element, kind);
      return;
    }
    if (node.type === "RestElement") {
      visitPattern(node.argument, kind);
      return;
    }
    if (node.type === "AssignmentPattern") visitPattern(node.left, kind);
  };

  const visitParams = (node) => {
    for (const param of node.params ?? []) {
      if (param.type === "TSParameterProperty") visitPattern(param.parameter, "parameter");
      else visitPattern(param, "parameter");
    }
  };

  const visitKey = (node, kind) => {
    if (node.computed) return;
    visitName(node.key, kind);
  };

  return {
    VariableDeclarator(node) {
      visitPattern(node.id, "variable");
    },
    FunctionDeclaration(node) {
      visitName(node.id, "function");
      visitParams(node);
    },
    FunctionExpression(node) {
      visitName(node.id, "function");
      visitParams(node);
    },
    ArrowFunctionExpression(node) {
      visitParams(node);
    },
    ClassDeclaration(node) {
      visitName(node.id, "type");
    },
    ClassExpression(node) {
      visitName(node.id, "type");
    },
    TSInterfaceDeclaration(node) {
      visitName(node.id, "type");
    },
    TSTypeAliasDeclaration(node) {
      visitName(node.id, "type");
    },
    TSEnumDeclaration(node) {
      visitName(node.id, "type");
    },
    TSEnumMember(node) {
      visitName(node.id, "type");
    },
    PropertyDefinition(node) {
      visitKey(node, "member");
    },
    MethodDefinition(node) {
      visitKey(node, "member");
    },
    TSAbstractPropertyDefinition(node) {
      visitKey(node, "member");
    },
    TSAbstractMethodDefinition(node) {
      visitKey(node, "member");
    },
  };
}
