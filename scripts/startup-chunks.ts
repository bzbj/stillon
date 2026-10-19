interface ModuleGraph { getModuleInfo(id: string): { importers: string[] } | null }

/** Follow only static importers. Dynamic previews must never join a boot chunk. */
export function staticallyUsedBy(id: string, entry: string, graph: ModuleGraph, visited = new Set<string>()): boolean {
  if (id.replaceAll("\\", "/").endsWith(entry)) return true
  if (visited.has(id)) return false
  visited.add(id)
  return graph.getModuleInfo(id)?.importers.some(importer => staticallyUsedBy(importer, entry, graph, visited)) ?? false
}

// Group only code already required by each startup phase. The priority preserves
// the small auth runtime when workspace/composer reuse React and shared helpers.
export const startupChunkGroups = [
  { name: (id: string, graph: ModuleGraph) => staticallyUsedBy(id, "/src/main.tsx", graph) ? "auth-runtime" : null, priority: 30 },
  { name: (id: string, graph: ModuleGraph) => staticallyUsedBy(id, "/src/client/app/AppRoot.tsx", graph) ? "workspace" : null, priority: 20 },
  { name: (id: string, graph: ModuleGraph) => staticallyUsedBy(id, "/src/client/components/chat-ui/ChatInput.tsx", graph) ? "composer" : null, priority: 10 },
]
