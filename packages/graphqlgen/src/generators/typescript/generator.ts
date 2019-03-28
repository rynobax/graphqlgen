import * as os from 'os'
import * as prettier from 'prettier'

import {
  GenerateArgs,
  ModelMap,
  ContextDefinition,
  CodeFileLike,
} from '../../types'
import {
  GraphQLTypeField,
  GraphQLTypeObject,
  GraphQLInterfaceObject,
  GraphQLTypeDefinition,
  GraphQLUnionObject,
} from '../../source-helper'
import {
  renderDefaultResolvers,
  getContextName,
  getModelName,
  TypeToInputTypeAssociation,
  InputTypesMap,
  printFieldLikeType,
  getDistinctInputTypes,
  renderEnums,
  groupModelsNameByImportPath,
  InterfacesMap,
  UnionsMap,
  createInterfacesMap,
  createUnionsMap,
  union,
  resolverReturnType,
} from '../common'
import { TypeAliasDefinition } from '../../introspection/types'
import { upperFirst } from '../../utils'

export function format(code: string, options: prettier.Options = {}) {
  try {
    return prettier.format(code, {
      ...options,
      parser: 'typescript',
    })
  } catch (e) {
    console.log(
      `There is a syntax error in generated code, unformatted code printed, error: ${JSON.stringify(
        e,
      )}`,
    )
    return code
  }
}

export function generate(args: GenerateArgs): string | CodeFileLike[] {
  // TODO: Maybe move this to source helper
  const inputTypesMap: InputTypesMap = args.types
    .filter(type => type.type.isInput)
    .reduce((inputTypes, type) => {
      return {
        ...inputTypes,
        [`${type.name}`]: type,
      }
    }, {})

  // TODO: Type this
  const typeToInputTypeAssociation: TypeToInputTypeAssociation = args.types
    .filter(
      type =>
        type.type.isObject &&
        type.fields.filter(
          field => field.arguments.filter(arg => arg.type.isInput).length > 0,
        ).length > 0,
    )
    .reduce((types, type) => {
      return {
        ...types,
        [`${type.name}`]: [].concat(
          ...(type.fields.map(field =>
            field.arguments
              .filter(arg => arg.type.isInput)
              .map(arg => arg.type.name),
          ) as any),
        ),
      }
    }, {})

  const interfacesMap = createInterfacesMap(args.interfaces)
  const unionsMap = createUnionsMap(args.unions)

  const enumsMap = createEnumsMap(args)

  const files: CodeFileLike[] = []
  // Objects
  files.push(
    ...args.types
      .filter(type => type.type.isObject)
      .map(type => {
        const hasPolymorphicObjects =
          !!type.implements && type.implements.length > 0
        const enums = getReferencedEnums(type, enumsMap)
        const neededModels = getObjectNeededModels(
          type,
          interfacesMap,
          unionsMap,
        )
        return {
          path: `${type.name}.ts`,
          force: true,
          code: `
      ${renderHeader(args, { enums, hasPolymorphicObjects, neededModels })}
      ${renderType(
        type,
        interfacesMap,
        unionsMap,
        typeToInputTypeAssociation,
        inputTypesMap,
        args,
      )}
      `,
        }
      }),
  )

  // Interfaces
  files.push(
    ...args.interfaces.map(type => {
      const neededModels = type.implementors.map(i => i.name)
      return {
        path: `${type.name}.ts`,
        force: true,
        code: `
      ${renderHeader(args, { neededModels })}
      ${renderInterface(type, interfacesMap, unionsMap, args)}
      `,
      }
    }),
  )

  // Unions
  files.push(
    ...args.unions.map(type => {
      const neededModels = type.types.map(i => i.name)
      return {
        path: `${type.name}.ts`,
        force: true,
        code: `
      ${renderHeader(args, { neededModels })}
      ${renderUnion(type, args)}
      `,
      }
    }),
  )

  // Enums
  if (args.enums.length > 0) {
    files.push({
      path: 'enums.ts',
      force: false,
      code: `${renderEnums(args)}`,
    })
  }

  // Index
  files.push({
    path: 'index.ts',
    force: false,
    code: `
    ${renderIndexHeader(args)}

    ${renderResolvers(args)}
    
    ${
      args.iResolversAugmentationEnabled
        ? renderGraphqlToolsModuleAugmentationIResolvers()
        : ''
    }
    `,
  })

  return files
}

/**
 * This renders a TypeScript module augmentation against graphql-tools
 * IResolvers type. Apollo Server uses that type to type its resolvers.
 * The problem with that type is that it is very loose compared to
 * graphqlgen including being an index type. The index type in particular
 * breaks compatibility with the resolvers generated by graphqlgen. We
 * fix this by augmenting the IResolvers type.
 *
 * References:
 *
 *  - https://www.typescriptlang.org/docs/handbook/declaration-merging.html
 *  - https://github.com/prisma/graphqlgen/issues/15
 */
const renderGraphqlToolsModuleAugmentationIResolvers = (): string => {
  // Use ts-ignore otherwise tests will throw an error about no such
  // module being found. Further, if a user for some reason is not using
  // Apollo Server, then this augmentation doesn't matter anyways, and
  // should not throw an exception for them either.
  return `
    // @ts-ignore
    declare module "graphql-tools" {
      interface IResolvers extends Resolvers {}
    }
  `
}

type HeaderOptions = {
  hasPolymorphicObjects?: boolean
  enums?: string[]
  neededModels?: string[]
}

function renderHeader(
  args: GenerateArgs,
  {
    hasPolymorphicObjects = false,
    enums = [],
    neededModels = [],
  }: HeaderOptions = {},
): string {
  const imports = hasPolymorphicObjects
    ? ['GraphQLResolveInfo', 'GraphQLIsTypeOfFn']
    : ['GraphQLResolveInfo']

  let enumImports = ''
  if (enums.length > 0) {
    enumImports = `import {${enums.join(', ')}} from './enums';`
  }
  return `
// Code generated by github.com/prisma/graphqlgen, DO NOT EDIT.

import { ${imports.join(', ')} } from 'graphql'
${renderModelAndContextImports(args, neededModels)}
${enumImports}
  `
}

function renderModelAndContextImports(
  args: GenerateArgs,
  modelsNeeded: string[],
) {
  const modelsToImport = Object.keys(args.modelMap)
    .filter(modelName => {
      const modelDef = args.modelMap[modelName].definition

      return !(
        modelDef.kind === 'TypeAliasDefinition' &&
        (modelDef as TypeAliasDefinition).isEnum
      )
    })
    .filter(modelName => modelsNeeded.includes(modelName))
    .map(modelName => args.modelMap[modelName])
  const modelsByImportPaths = groupModelsNameByImportPath(modelsToImport)

  if (args.context) {
    const importsFromContextPath =
      modelsByImportPaths[args.context.contextPath] || []

    return importsToString(
      Object.assign({}, modelsByImportPaths, {
        [args.context.contextPath]: importsFromContextPath.concat(
          getContextName(args.context),
        ),
      }),
    )
  }

  return `${importsToString(modelsByImportPaths)}${os.EOL}type ${getContextName(
    args.context,
  )} = any`
}

function importsToString(
  modelsByImportPaths: ReturnType<typeof groupModelsNameByImportPath>,
) {
  return Object.keys(modelsByImportPaths)
    .map(
      importPath =>
        `import { ${modelsByImportPaths[importPath].join(
          ', ',
        )} } from '${importPath}'`,
    )
    .join(os.EOL)
}

function renderIndexHeader(args: GenerateArgs): string {
  const types = [...args.types, ...args.interfaces, ...args.unions].filter(
    t => !t.type.isInput && !t.type.isEnum,
  )
  return `
// Code generated by github.com/prisma/graphqlgen, DO NOT EDIT.

${types
    .map(type => `import * as ${type.name}Resolvers from './${type.name}';`)
    .join(os.EOL)}
  `
}

function renderInterface(
  graphQLTypeObject: GraphQLInterfaceObject,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  args: GenerateArgs,
): string {
  return `\
    ${renderInputArgInterfaces(
      graphQLTypeObject,
      args.modelMap,
      interfacesMap,
      unionsMap,
    )}

    export interface I${graphQLTypeObject.name} {
      __resolveType: ${renderTypeResolveTypeResolver(graphQLTypeObject, args)}
    }
  `
}

export const renderTypeResolveTypeResolver = (
  abstractType: GraphQLInterfaceObject | GraphQLUnionObject,
  args: GenerateArgs,
): string => {
  const modelNames: string[] = []
  const gqlObjectNameTypes: string[] = []
  const gqlObjects =
    abstractType.kind === 'interface'
      ? abstractType.implementors
      : abstractType.types

  for (const gqlObj of gqlObjects) {
    modelNames.push(getModelName(gqlObj, args.modelMap))
    gqlObjectNameTypes.push(renderStringConstant(gqlObj.name))
  }

  return `
  (
    value: ${union(modelNames)},
    context: ${getContextName(args.context)},
    info: GraphQLResolveInfo
  ) => ${resolverReturnType(union(gqlObjectNameTypes))}
  `
}

const renderStringConstant = (x: unknown) => `"${x}"`

function renderUnion(
  graphQLTypeObject: GraphQLUnionObject,
  args: GenerateArgs,
): string {
  return `\
    export interface I${graphQLTypeObject.name} {
      __resolveType?: ${renderTypeResolveTypeResolver(graphQLTypeObject, args)}
    }
  `
}

function renderType(
  graphQLTypeObject: GraphQLTypeObject,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
  args: GenerateArgs,
): string {
  return `\
  ${
    args.defaultResolversEnabled
      ? renderDefaultResolvers(graphQLTypeObject, args, 'defaultResolvers')
      : ''
  }

  ${renderInputTypeInterfaces(
    graphQLTypeObject,
    args.modelMap,
    interfacesMap,
    unionsMap,
    typeToInputTypeAssociation,
    inputTypesMap,
  )}

  ${renderInputArgInterfaces(
    graphQLTypeObject,
    args.modelMap,
    interfacesMap,
    unionsMap,
  )}

  ${renderResolverFunctionInterfaces(
    graphQLTypeObject,
    args.modelMap,
    interfacesMap,
    unionsMap,
    args.context,
  )}

  ${renderResolverTypeInterface(
    graphQLTypeObject,
    args.modelMap,
    interfacesMap,
    unionsMap,
    args.context,
  )}

  ${/* TODO renderResolverClass(type, modelMap) */ ''}
  `
}

function renderIsTypeOfFunctionInterface(
  type: GraphQLTypeObject | GraphQLInterfaceObject,
  modelMap: ModelMap,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  context?: ContextDefinition,
) {
  let possibleTypes: GraphQLTypeDefinition[] = []

  // TODO Refactor once type is a proper discriminated union
  if (!type.type.isInterface) {
    type = type as GraphQLTypeObject
    if (type.implements) {
      possibleTypes = type.implements.reduce(
        (obj: GraphQLTypeDefinition[], interfaceName) => {
          return [...obj, ...interfacesMap[interfaceName]]
        },
        [],
      )
    }
  }

  for (let unionName in unionsMap) {
    if (unionsMap[unionName].find(unionType => unionType.name === type.name)) {
      possibleTypes = unionsMap[unionName]
    }
  }

  if (possibleTypes.length === 0) {
    return ''
  }
  return `\
    __isTypeOf?: GraphQLIsTypeOfFn<${possibleTypes
      .map(possibleType => getModelName(possibleType, modelMap))
      .join(' | ')}, ${getContextName(context)}>;`
}

function renderInputTypeInterfaces(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  typeToInputTypeAssociation: TypeToInputTypeAssociation,
  inputTypesMap: InputTypesMap,
) {
  if (!typeToInputTypeAssociation[type.name]) {
    return ``
  }

  return getDistinctInputTypes(type, typeToInputTypeAssociation, inputTypesMap)
    .map(typeAssociation => {
      const inputType = inputTypesMap[typeAssociation]
      return `export interface ${inputType.name} {
      ${inputType.fields.map(field =>
        printFieldLikeType(field, modelMap, interfacesMap, unionsMap),
      )}
    }`
    })
    .join(os.EOL)
}

function renderInputArgInterfaces(
  type: GraphQLTypeObject | GraphQLInterfaceObject,
  modelMap: ModelMap,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
): string {
  return type.fields
    .map(field =>
      renderInputArgInterface(field, modelMap, interfacesMap, unionsMap),
    )
    .join(os.EOL)
}

function renderInputArgInterface(
  field: GraphQLTypeField,
  modelMap: ModelMap,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
): string {
  if (field.arguments.length === 0) {
    return ''
  }

  return `
  export interface Args${upperFirst(field.name)} {
    ${field.arguments
      .map(arg =>
        printFieldLikeType(
          arg as GraphQLTypeField,
          modelMap,
          interfacesMap,
          unionsMap,
        ),
      )
      .join(os.EOL)}
  }
  `
}

function renderResolverFunctionInterfaces(
  type: GraphQLTypeObject,
  modelMap: ModelMap,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  context?: ContextDefinition,
): string {
  return type.fields
    .map(
      field =>
        `export type ${upperFirst(field.name)}Resolver = ${renderTypeResolver(
          field,
          type,
          modelMap,
          interfacesMap,
          unionsMap,
          context,
        )}`,
    )
    .join(os.EOL)
}

function renderResolverTypeInterface(
  type: GraphQLTypeObject | GraphQLInterfaceObject,
  modelMap: ModelMap,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  context?: ContextDefinition,
): string {
  return `
  export interface I${type.name} {
    ${type.fields
      .map(
        field =>
          `${field.name}: ${renderTypeResolver(
            field,
            type,
            modelMap,
            interfacesMap,
            unionsMap,
            context,
          )}`,
      )
      .join(os.EOL)}
      ${renderIsTypeOfFunctionInterface(
        type,
        modelMap,
        interfacesMap,
        unionsMap,
        context,
      )}
  }
  `
}

const renderTypeResolver = (
  field: GraphQLTypeField,
  type: GraphQLTypeObject | GraphQLInterfaceObject,
  modelMap: ModelMap,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
  context?: ContextDefinition,
): string => {
  let parent: string

  if (type.type.isInterface) {
    const implementingTypes = interfacesMap[type.name]

    parent = implementingTypes
      .map(implType => getModelName(implType, modelMap, 'undefined'))
      .join(' | ')
  } else {
    parent = getModelName(type.type as any, modelMap, 'undefined')
  }

  const params = `
  (
    parent: ${parent},
    args: ${
      field.arguments.length > 0 ? `Args${upperFirst(field.name)}` : '{}'
    },
    ctx: ${getContextName(context)},
    info: GraphQLResolveInfo,
  )
  `
  const returnType = printFieldLikeType(
    field,
    modelMap,
    interfacesMap,
    unionsMap,
    { isReturn: true },
  )

  if (type.name === 'Subscription') {
    return `
    {
      subscribe: ${params} => ${resolverReturnType(
      `AsyncIterator<${returnType}>`,
    )}
      resolve?: ${params} => ${resolverReturnType(returnType)}
    }
    `
  }

  const resolveFunc = `${params} => ${resolverReturnType(returnType)}`

  const DelegatedParentResolver = `
    {
      fragment: string
      resolve: ${resolveFunc}
    }
  `

  const resolver = union([`(${resolveFunc})`, DelegatedParentResolver])

  return resolver
}

function renderResolvers(args: GenerateArgs): string {
  return `\
export interface Resolvers {
  ${[
    ...args.types
      .filter(obj => obj.type.isObject)
      .map(type => `${type.name}: ${type.name}Resolvers.I${type.name}`),
    ...args.interfaces.map(
      type => `${type.name}?: ${type.name}Resolvers.I${type.name}`,
    ),
    ...args.unions.map(
      type => `${type.name}?: ${type.name}Resolvers.I${type.name}`,
    ),
  ].join(os.EOL)}
}
  `
}

type EnumsMap = Record<string, string[]>

// typename: Enums used
function createEnumsMap(args: GenerateArgs): EnumsMap {
  return args.types.reduce<EnumsMap>((enumsMap, type) => {
    enumsMap[type.name] = []
    type.fields.forEach(t => {
      if (t.type.isEnum) {
        enumsMap[type.name].push(t.type.name)
      }
      t.arguments.forEach(a => {
        if (a.type.isEnum) {
          enumsMap[type.name].push(a.type.name)
        }
      })
    })
    return enumsMap
  }, {})
}

function getReferencedEnums(
  type: GraphQLTypeObject,
  enumsMap: EnumsMap,
): string[] {
  const referencedTypeNames = [type.name]
  type.fields.forEach(t => {
    t.arguments.forEach(a => {
      referencedTypeNames.push(a.type.name)
    })
  })

  const referencedEnums: string[] = []
  referencedTypeNames.forEach(t => {
    const enums = enumsMap[t]
    if (enums) {
      referencedEnums.push(...enums)
    }
  })
  return referencedEnums
}

function getObjectNeededModels(
  type: GraphQLTypeObject,
  interfacesMap: InterfacesMap,
  unionsMap: UnionsMap,
): string[] {
  const neededModels: string[] = [type.name]

  // Types used in it's fields
  type.fields.forEach(field => {
    if (field.type.isInterface) {
      // TODO: Not sure if this is needed
      // Interfaces push the types they are implemented by
      interfacesMap[field.type.name].forEach(t => {
        neededModels.push(t.name)
      })
    } else if (field.type.isUnion) {
      // TODO: I think this is needed, but double check
      // Unions push the types they are made of
      unionsMap[field.type.name].forEach(t => {
        neededModels.push(t.name)
      })
    } else {
      neededModels.push(field.type.name)
    }
    if (field.arguments) {
      field.arguments.forEach(a => {
        neededModels.push(a.type.name)
      })
    }
  })

  // Types used in __isTypeOf
  if (type.implements) {
    type.implements.forEach(i => {
      interfacesMap[i].forEach(t => {
        neededModels.push(t.name)
      })
    })
  }

  if (type.name === 'Film') {
    console.log(type)
  }
  return neededModels
}
