// The options Navigator passes to jco's component generator, in one place so every host (Node and
// browser) turns a hash-verified component into the same code.
//
// We always ask for `instantiation: async`: the generated module exports `instantiate(getCoreModule,
// imports)` and imports nothing itself, so the host decides exactly what the component can reach.

export function generateOptions(name = "app") {
  return {
    name,
    map: [],
    instantiation: { tag: "async" },
    asyncMode: undefined,
    importBindings: undefined,
    validLiftingOptimization: false,
    tracing: false,
    noComponentErrorWrapping: false, // exports throw ComponentError with the WIT error in .payload
    noNodejsCompat: true,
    noTypescript: true,
    tlaCompat: false,
    base64Cutoff: 5000,
    noNamespacedExports: false,
    multiMemory: false,
    bindgenEnableWasmExnref: false,
    strict: false,
    perfStringsSkipCopyUtf8Validation: false,
    perfStringsSkipCopyUtf16Validation: false,
    cmRuntimeEsModule: undefined,
    flagsAsBigint: false,
    variantsInlineCases: false,
    useNamespaceObjects: false,
    enumValuesScreamingSnakeCase: false,
    idlImports: false,
    asmjs: false,
    emitConditionalSuspendingWasm: true,
  };
}
