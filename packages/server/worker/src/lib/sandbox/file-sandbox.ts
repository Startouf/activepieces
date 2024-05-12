import { cp, mkdir, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'worker_threads'
import { fileExists, logger, system, SystemProp } from '@activepieces/server-shared'
import { EngineOperation, EngineResponse, EngineResponseStatus } from '@activepieces/shared'
import fs from 'fs-extra'
import {
    AbstractSandbox,
    ExecuteSandboxResult,
    SandboxCtorParams,
} from './abstract-sandbox'

const memoryLimit = Math.floor((Number(system.getOrThrow(SystemProp.SANDBOX_MEMORY_LIMIT)) / 1024))
export class FileSandbox extends AbstractSandbox {
    private readonly ENGINE_FILES = ['codes', 'node_modules', 'main.js', 'main.js.map', 'package.json']

    public constructor(params: SandboxCtorParams) {
        super(params)
    }

    public override async cleanUp(): Promise<void> {
        logger.debug({ boxId: this.boxId }, '[FileSandbox#recreate]')


        const sandboxFolderPath = this.getSandboxFolderPath()

        const sandboxFileExists = await fileExists(sandboxFolderPath)
        if (!sandboxFileExists) {
            return
        }
        try {

            const files = await fs.readdir(sandboxFolderPath)
            for (const file of files) {
                const filePath = path.join(sandboxFolderPath, file)
                const fileStats = await fs.stat(filePath)
                if (this.ENGINE_FILES.includes(file)) {
                    continue
                }
                if (fileStats.isFile()) {
                    await fs.unlink(filePath)
                }
                else {
                    await rmdir(filePath, { recursive: true })
                }
            }

        }
        catch (e) {
            logger.debug(
                e,
                `[Sandbox#recreateCleanup] rmdir failure ${sandboxFolderPath}`,
            )
        }

    }

    public async runOperation(
        operationType: string,
        operation: EngineOperation,
    ): Promise<ExecuteSandboxResult> {
        const startTime = Date.now()

        const enginePath = path.resolve(path.join(this.getSandboxFolderPath(), 'main.js'))
        const { engine, stdError, stdOut } = await createWorker(enginePath, operationType, operation)
        return {
            timeInSeconds: (Date.now() - startTime) / 1000,
            verdict: engine.status,
            output: engine.response,
            standardOutput: stdOut,
            standardError: stdError,
        }
    }

    public override getSandboxFolderPath(): string {
        const systemCache = system.get(SystemProp.CACHE_PATH) ?? __dirname
        return path.join(systemCache, 'sandbox', `${this.boxId}`)
    }

    protected override async setupCache(cacheChanged: boolean): Promise<void> {
        logger.debug(
            {
                boxId: this.boxId,
                cacheKey: this._cacheKey,
                cachePath: this._cachePath,
            },
            '[FileSandbox#setupCache]',
        )

        if (!cacheChanged) {
            logger.debug({
                cacheKey: this._cacheKey,
            }, '[FileSandbox#setupCache] skip setup cache')
            return
        }
        const cacheExists = await fileExists(this.getSandboxFolderPath())
        if (cacheExists) {
            await rmdir(this.getSandboxFolderPath(), { recursive: true })
        }
        await mkdir(this.getSandboxFolderPath(), { recursive: true })

        if (this._cachePath) {
            if (process.platform === 'win32') {
                await fs.copy(this._cachePath, this.getSandboxFolderPath())
            }
            else {
                await cp(this._cachePath, this.getSandboxFolderPath(), {
                    recursive: true,
                })
            }
        }
    }


}
function createWorker(enginePath: string,
    operationType: string,
    operation: EngineOperation) {
    return new Promise<{
        engine: EngineResponse<unknown>
        stdOut: string
        stdError: string
    }>((resolve, reject) => {
        const worker = new Worker(enginePath, {
            workerData: {
                operationType,
                operation,
            },
            resourceLimits: {
                maxOldGenerationSizeMb: memoryLimit,
                maxYoungGenerationSizeMb: memoryLimit,
                stackSizeMb: memoryLimit,
            },
        })

        const timeoutWorker = setTimeout(async () => {
            await worker.terminate()
            resolve({
                engine: {
                    status: EngineResponseStatus.TIMEOUT, response: {},
                },
                stdError: '',
                stdOut: '',
            })
        }, AbstractSandbox.sandboxRunTimeSeconds * 1000)

        let stdError = ''
        let stdOut = ''

        worker.on('message', (m: { type: string, message: unknown }) => {
            if (m.type === 'result') {
                clearTimeout(timeoutWorker)
                resolve({
                    engine: m.message as EngineResponse<unknown>,
                    stdOut,
                    stdError,
                })
            }
            else if (m.type === 'stdout') {
                stdOut += m.message
            }
            else if (m.type === 'stderr') {
                stdError += m.message
            }
        })

        worker.on('error', () => {
            clearTimeout(timeoutWorker)
            reject({ status: EngineResponseStatus.ERROR, response: {} })
        })

        worker.on('exit', () => {
            clearTimeout(timeoutWorker)
            reject({ status: EngineResponseStatus.ERROR, response: {} })
        })
    })

}