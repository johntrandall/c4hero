/**
 * Save round-trip, with nothing mocked between `writeLinkedWorkspace` and the
 * file handles.
 *
 * Two properties are asserted together because they pull against each other,
 * and a fix for one is easy to write in a way that breaks the other:
 *
 *   1. Saving a workspace that has not changed must touch no file. The
 *      workspace object changes whenever a workspace is LOADED, so an ungated
 *      save turns "open a diagram" into an edit of the file that diagram came
 *      from — which is what makes two tabs on one folder two writers rather
 *      than one writer and one reader.
 *
 *   2. Moving a node must still reach disk. `updateNodePosition` deliberately
 *      records no undo entry ("Don't push undo for every drag position — too
 *      noisy", view-slice.ts), so any attempt to gate saving on the undo stack
 *      silently stops persisting layout — the single edit this app exists for.
 *
 * The first property is why the byte comparison exists; the second is why it
 * has to live at the file level rather than in a dirtiness flag.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { setDirHandle, writeDSLFile, writeSidecarFile } from './folderIO'
import { writeLinkedWorkspace } from './workspaceSave'
import { parseDSL } from './dsl'
import type { Workspace } from '@/types/model'

const DSL = `workspace "Shop" {
  model {
    u = person "Customer"
    s = softwareSystem "Shop"
    u -> s "buys from"
  }
  views {
    systemContext s "Ctx" {
      include *
    }
  }
}`

/** Files that remember their content and count how many times a writable was
 *  opened on them, so a test can assert a write did NOT happen. */
function makeCountingDirHandle(files: Record<string, string> = {}) {
  const content: Record<string, string> = { ...files }
  const opened: Record<string, number> = {}
  const handleFor = (name: string) => ({
    kind: 'file' as const,
    name,
    getFile: async () => new File([content[name] ?? ''], name, { type: 'text/plain' }),
    createWritable: async () => {
      opened[name] = (opened[name] ?? 0) + 1
      let buf = ''
      return { write: (d: string) => { buf += d }, close: async () => { content[name] = buf } }
    },
  })
  const dir = {
    kind: 'directory',
    name: 'arch',
    entries: async function* () { for (const n of Object.keys(content)) yield [n, handleFor(n)] },
    getFileHandle: async (name: string, opts?: { create?: boolean }) => {
      if (name in content) return handleFor(name)
      if (opts?.create) { content[name] = ''; return handleFor(name) }
      throw new DOMException('Not found', 'NotFoundError')
    },
    queryPermission: async () => 'granted' as PermissionState,
  } as unknown as FileSystemDirectoryHandle
  return { dir, content, opened }
}

/** Move one node in the first system-context view, the way a drag does. */
function moveFirstNode(workspace: Workspace, x: number, y: number): void {
  const view = workspace.views.systemContextViews[0]
  const element = view.elements[0]
  element.x = x
  element.y = y
  element.pinned = true
}

let rig: ReturnType<typeof makeCountingDirHandle>

beforeEach(async () => {
  rig = makeCountingDirHandle()
  await setDirHandle(rig.dir)
})

describe('saving the same workspace twice', () => {
  it('writes the first time and touches nothing the second', async () => {
    const workspace = parseDSL(DSL).workspace

    expect(await writeLinkedWorkspace(workspace, 'shop.dsl')).toBe(true)
    const afterFirst = { ...rig.opened }
    expect(afterFirst['shop.dsl']).toBe(1)

    expect(await writeLinkedWorkspace(workspace, 'shop.dsl')).toBe(true)
    expect(rig.opened).toEqual(afterFirst)
  })

  it('reports success when it skips, so the caller still marks the workspace saved', async () => {
    const workspace = parseDSL(DSL).workspace
    await writeLinkedWorkspace(workspace, 'shop.dsl')
    expect(await writeLinkedWorkspace(workspace, 'shop.dsl')).toBe(true)
  })
})

describe('a node drag still reaches disk', () => {
  it('writes the sidecar after a position change, even though no undo entry was recorded', async () => {
    const workspace = parseDSL(DSL).workspace
    await writeLinkedWorkspace(workspace, 'shop.dsl')
    const sidecarWritesBefore = rig.opened['shop.c4hero.json'] ?? 0

    moveFirstNode(workspace, 1234, 5678)
    expect(await writeLinkedWorkspace(workspace, 'shop.dsl')).toBe(true)

    expect(rig.opened['shop.c4hero.json']).toBe(sidecarWritesBefore + 1)
    expect(rig.content['shop.c4hero.json']).toContain('1234')
    expect(rig.content['shop.c4hero.json']).toContain('5678')
  })

  it('leaves the DSL alone when only the layout moved', async () => {
    const workspace = parseDSL(DSL).workspace
    await writeLinkedWorkspace(workspace, 'shop.dsl')
    const dslWritesBefore = rig.opened['shop.dsl']

    moveFirstNode(workspace, 42, 99)
    await writeLinkedWorkspace(workspace, 'shop.dsl')

    expect(rig.opened['shop.dsl']).toBe(dslWritesBefore)
  })

  it('writes the DSL when the model changes, and not merely when it is saved again', async () => {
    const workspace = parseDSL(DSL).workspace
    await writeLinkedWorkspace(workspace, 'shop.dsl')
    const dslWritesBefore = rig.opened['shop.dsl']

    workspace.model.softwareSystems[0].description = 'Now it has a description'
    await writeLinkedWorkspace(workspace, 'shop.dsl')
    expect(rig.opened['shop.dsl']).toBe(dslWritesBefore + 1)

    await writeLinkedWorkspace(workspace, 'shop.dsl')
    expect(rig.opened['shop.dsl']).toBe(dslWritesBefore + 1)
  })
})

describe('the writers themselves', () => {
  it('skip identical content and write changed content', async () => {
    expect(await writeDSLFile('a.dsl', 'workspace "A" {}')).toBe(true)
    expect(rig.opened['a.dsl']).toBe(1)

    expect(await writeDSLFile('a.dsl', 'workspace "A" {}')).toBe(true)
    expect(rig.opened['a.dsl']).toBe(1)

    expect(await writeDSLFile('a.dsl', 'workspace "B" {}')).toBe(true)
    expect(rig.opened['a.dsl']).toBe(2)

    const json = '{"version":1,"views":{}}'
    expect(await writeSidecarFile('a.dsl', json)).toBe(true)
    expect(rig.opened['a.c4hero.json']).toBe(1)
    expect(await writeSidecarFile('a.dsl', json)).toBe(true)
    expect(rig.opened['a.c4hero.json']).toBe(1)
  })
})
