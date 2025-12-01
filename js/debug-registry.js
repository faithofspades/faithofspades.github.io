// Registry for sharing audio graph references without sprinkling window.* assignments.
const registry = new Map();

export function registerDebugReference(name, value) {
    if (!name || value === undefined || value === null) {
        return value;
    }
    registry.set(name, value);
    return value;
}

export function getDebugReference(name) {
    return registry.get(name) ?? null;
}

export function listDebugReferences() {
    return Array.from(registry.keys()).sort();
}

function bootstrapGlobalNamespace() {
    if (typeof globalThis === 'undefined') {
        return;
    }
    const namespace = globalThis.polyhymnDebug || {};
    namespace.refs = {
        get: getDebugReference,
        list: listDebugReferences
    };
    globalThis.polyhymnDebug = namespace;
}

bootstrapGlobalNamespace();
