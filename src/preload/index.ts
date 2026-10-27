import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { Api } from '@shared/api'

const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

const api: Api = {
  platform: process.platform,
  connections: {
    list: call('connections:list'),
    save: call('connections:save'),
    remove: call('connections:remove'),
    test: call('connections:test'),
    open: call('connections:open')
  },
  db: {
    query: call('db:query'),
    dryRun: call('db:dryRun'),
    schema: call('db:schema')
  },
  files: {
    pickSqlite: call('files:pickSqlite'),
    import: call('files:import'),
    pathFor: (file) => webUtils.getPathForFile(file),
    export: call('files:export')
  },
  sample: call('sample'),
  settings: { get: call('settings:get'), set: call('settings:set') },
  history: { list: call('history:list'), add: call('history:add'), clear: call('history:clear') }
} as Api

contextBridge.exposeInMainWorld('api', api)
