/*     
 * Copyright 2018 Christoph Seitz
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
*/

/*
 * Client code for interaction with CMake
 */

import * as vscode from 'vscode';
import * as net from 'net';
import * as child_process from 'child_process';
import * as process from 'process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import * as protocol from './protocol';
import { LineTransform } from '../helpers/stream';
import { ProblemMatcher, getProblemMatchers } from '../helpers/problemMatcher';
import { Lock } from '../helpers/lock';

const readdir = util.promisify(fs.readdir);
const lstat = util.promisify(fs.lstat);
const unlink = util.promisify(fs.unlink);
const rmdir = util.promisify(fs.rmdir);

enum ClientState {
    STOPPED,
    CONNECTED,
    RUNNING,
    CONFIGURED,
    GENERATED,
    BUILDING
}

class ProjectContext {
    currentTargetName : string = "";
}

interface ProjectContextMap {
    [key : string] : ProjectContext;
}

class ClientContext {
    currentProjectName : string = "";
    currentBuildType : string = "Debug";
    projectContexts : ProjectContextMap = {};
}

export class CMakeClient implements vscode.Disposable {

    private _process: child_process.ChildProcess | undefined;
    private _connection: protocol.CMakeProtocolConnection | undefined;

    private _state: ClientState = ClientState.STOPPED;
    private _hello: Promise<protocol.Hello> | undefined;
    private _lock : Lock = new Lock();

    private _model: protocol.CodeModel | undefined;
    private _cache: Map<string, protocol.CacheValue> = new Map();

    private _console: vscode.OutputChannel;
    private _diagnostics: vscode.DiagnosticCollection;

    private _onModelChange: vscode.EventEmitter<CMakeClient> = new vscode.EventEmitter();
    readonly onModelChange: vscode.Event<CMakeClient> = this._onModelChange.event;

    private _sourceDirectory: string;
    private _buildDirectory: string;

    private _clientContext : ClientContext;
    private _project: protocol.Project | undefined;
    private _target: protocol.Target | undefined;

    private _projects : protocol.Project[] = [];
    private _targets : protocol.Target[] = [];
    private _projectTargets: Map<protocol.Project, protocol.Target[]> = new Map();
    private _targetProjects: Map<protocol.Target, protocol.Project> = new Map();

    private _matchers: ProblemMatcher[];
    

    constructor(
        readonly uri: vscode.Uri,
        private _context: vscode.ExtensionContext
    ) {
        this._sourceDirectory = path.dirname(this.uri.fsPath).replace(/\\/g, "/");
        this._buildDirectory = path.join(this._sourceDirectory, vscode.workspace.getConfiguration("cmake", this.uri).get("buildDirectory", "build")).replace(/\\/g, "/");

        this._matchers = getProblemMatchers(this._buildDirectory);
        this._diagnostics = vscode.languages.createDiagnosticCollection(this.name);
        this._console = vscode.window.createOutputChannel("CMake (" + this.name + ")");

        this._clientContext = this._context.workspaceState.get(this.name + "-context", new ClientContext());
    }

    public get generator(): string {
        return vscode.workspace.getConfiguration("cmake", this.uri).get("generator", "Ninja");
    }

    public get extraGenerator(): string | undefined {
        return vscode.workspace.getConfiguration("cmake", this.uri).get("extraGenerator");
    }

    public get generatorPlatform(): string | undefined {
        return vscode.workspace.getConfiguration("cmake", this.uri).get("generatorPlatform");
    }

    public get generatorToolset(): string | undefined {
        return vscode.workspace.getConfiguration("cmake", this.uri).get("generatorToolset");
    }

    public get buildTypes(): string[] {
        if (this._model === undefined) {
            return [];
        } else {
            let types = new Set<string>();
            if (!this.isConfigurationGenerator) {
                ["Debug", "Release", "RelWithDebInfo", "MinSizeRel"].forEach(types.add, types);
                vscode.workspace.getConfiguration("cmake", this.uri).get<string[]>("buildTypes", []).forEach(types.add, types);
            } else {
                this._model.configurations.forEach((value) => types.add(value.name));
            }
            return Array<string>(...types.values());
        }
    }

    public get buildType(): string {
        return this._clientContext.currentBuildType;
    }
    public set buildType(v: string) {
        this._clientContext.currentBuildType = v;
        this._context.workspaceState.update(this.name + "-context", this._clientContext);
    }

    public get projects(): protocol.Project[] {
        return this._projects;
    }

    public get project(): protocol.Project | undefined {
        return this._project;
    }
    public set project(v: protocol.Project | undefined) {
        if (v && this._projectTargets.has(v)) {
            this._project = v;

            if (this.projectBuildTargets.length > 0 ) {
                this._target = this.projectBuildTargets.find(
                    (value) => value.name === this.currentProjectContext!.currentTargetName
                ) || this.projectBuildTargets[0];
                this.currentProjectContext!.currentTargetName = this._target.name;
            } else {
                this._target = undefined;
            }
        }
        this.updateContext();
    }

    public get projectTargets(): protocol.Target[] {
        if (this.project) {
            return this.project.targets;
        } else {
            return [];
        }
    }

    public get projectBuildTargets() : protocol.Target[] {
        return this.projectTargets.filter((value) => value.type !== "INTERFACE_LIBRARY");
    }

    public get targets() : protocol.Target[] {
        return this._targets;
    }

    public get target(): protocol.Target | undefined {
        return this._target;
    }
    public set target(v: protocol.Target | undefined) {
        if (v && this._targetProjects.has(v)) {
            this._target = v;
            this._project = this._targetProjects.get(v)!;
        } else {
            this._target = undefined;
        }
        this.updateContext();
    }

    public get isConfigurationGenerator(): boolean {
        return this.generator.match(/^Visual Studio/) !== null;
    }

    public get name(): string {
        return path.basename(this._sourceDirectory);
    }

    public get sourceDirectory(): string {
        return this._sourceDirectory;
    }

    private get pipeName(): string {
        if (process.platform === "win32") {
            return "\\\\?\\pipe\\" + this.name + "-" + process.pid + "-cmake";
        } else {
            return path.join(os.tmpdir(), this.name + "-" + process.pid + "-cmake.sock");
        }
    }

    private get currentProjectContext() : ProjectContext | undefined {
        if (this._project) {
            let projectContext : ProjectContext;
            if (!this._clientContext.projectContexts.hasOwnProperty(this._project.name)) {
                projectContext = new ProjectContext();
                this._clientContext.projectContexts[this._project.name] = projectContext;
            } else {
                projectContext = this._clientContext.projectContexts[this._project.name];
            }
            return projectContext;
        }
        return undefined;
    }
    
    private updateContext() {
        if (this._project) {
            this._clientContext.currentProjectName = this._project.name;

            if (this._target) {
                this.currentProjectContext!.currentTargetName = this._target.name;
            } else {
                this.currentProjectContext!.currentTargetName = "";
            }
        } else {
            this._clientContext.currentProjectName = "";
        }
        this._context.workspaceState.update(this.name + "-context", this._clientContext);
    }

    async start() {
        if (this._state >= ClientState.RUNNING) {
            return;
        }

        await this.createConnection();

        let msg = await this._hello!;
        let handshake: protocol.Handshake = {
            sourceDirectory: this._sourceDirectory,
            buildDirectory: this._buildDirectory,
            protocolVersion: msg.supportedProtocolVersions[0],
            generator: this.generator,
            extraGenerator: this.extraGenerator,
            platform: this.generatorPlatform,
            toolset: this.generatorToolset
        };
        await this._connection!.handshake(handshake);
    }

    async stop() {
        if (this._state === ClientState.STOPPED) {
            return;
        }
        await new Promise((resolve) => {
            this._process!.once('exit', () => resolve());
            this._process!.kill();
        });

        try {
            await unlink(this.pipeName);
        } catch (e) {
        }
    }

    async configure() {
        this.checkReady();
        await this._lock.lock();
        if (vscode.workspace.getConfiguration("cmake").get("showConsoleAutomatically", true)) {
            this._console.show();
        }

        let args: string[] = [];
        let cacheEntries = vscode.workspace.getConfiguration("cmake", this.uri).get<any>("cacheEntries", {});
        for (let entry in cacheEntries) {
            args.push("-D" + entry + "=" + cacheEntries[entry]);
        }

        if (!this.isConfigurationGenerator && this.buildType) {
            args.push("-DCMAKE_BUILD_TYPE=" + this.buildType);
        }
        this._state = ClientState.RUNNING;
        await this._connection!.configure(args);
        this._state = ClientState.CONFIGURED;
        this._lock.unlock();
    }

    async generate() {
        this.checkReady();
        if (this._state === ClientState.RUNNING) {
            await this.configure();
        }
        await this._lock.lock();
        this._state = ClientState.CONFIGURED;
        await this._connection!.compute();
        this._state = ClientState.GENERATED;
        this._lock.unlock();
    }

    async removeBuildDirectory() {
        if (this._state > ClientState.RUNNING) {
            this._state = ClientState.RUNNING;
        }

        let removeDir = async (dir: string) => {
            try {
                await lstat(dir);
            } catch (e) {
                return;
            }
            let files = await readdir(dir);
            await Promise.all(files.map(async (file) => {
                let p = path.join(dir, file);
                const stat = await lstat(p);
                if (stat.isDirectory()) {
                    await removeDir(p);
                } else {
                    await unlink(p);
                }
            }));
            await rmdir(dir);
        };
        await removeDir(this._buildDirectory);
    }

    async updateModel() {
        this.checkReady();
        if (this._state < ClientState.GENERATED) {
            throw new Error("Build system not generated yet.");
        }
        this._model = await this._connection!.codemodel();
        this.updateValues();
        
        let cache = await this._connection!.cache();
        this._cache.clear();
        cache.forEach((value) => this._cache.set(value.key, value));

        this._onModelChange.fire(this);
    }

    getCacheValue(key : string) : protocol.CacheValue | undefined {
        return this._cache.get(key);
    }

    async build(target?: string) {
        if (this._state < ClientState.GENERATED) {
            throw new Error("Build system not generated yet.");
        }
        if (this._state === ClientState.BUILDING) {
            return;
        }
        if (vscode.workspace.getConfiguration("cmake").get("showConsoleAutomatically", true)) {
            this._console.show();
        }

        let cmakePath = vscode.workspace.getConfiguration("cmake", this.uri).get("cmakePath", "cmake");
        let args: string[] = [];
        args.push("--build", this._buildDirectory);
        if (target) {
            args.push("--target", target);
        }
        if (this.isConfigurationGenerator) {
            args.push("--config", this.buildType!);
        }
        let configEnv = vscode.workspace.getConfiguration("cmake", this.uri).get("buildEnvironment", {});
        let processEnv = process.env;
        let env = { ...processEnv, ...configEnv };

        this._matchers.forEach((value) => value.clear());
        let buildProc = child_process.execFile(cmakePath, args, {
            env: env
        });
        this._state = ClientState.BUILDING;

        buildProc.stdout.pipe(new LineTransform()).on("data", (chunk: string) => {
            this._console.appendLine(chunk);
            this.handleBuildLine(chunk);
        });
        buildProc.stderr.pipe(new LineTransform()).on("data", (chunk: string) => {
            this._console.appendLine(chunk);
            this.handleBuildLine(chunk);
        });

        return new Promise((resolve, reject) => {
            buildProc.on("error", (err) => {
                this._state = ClientState.GENERATED;
                reject(err);
            });
            buildProc.on("exit", (code, signal) => {
                this._diagnostics.set(
                    this._matchers.reduce((previous, current) =>
                        previous.concat(current.getDiagnostics()),
                        [] as [vscode.Uri, vscode.Diagnostic[] | undefined][])
                );
                this._state = ClientState.GENERATED;
                resolve();
            });
        });
    }

    dispose() {
        this.stop();
    }

    private updateValues() {
        this.buildType =
            this.buildTypes.find(
                (value) => value === this.buildType) ||
            this.buildTypes[0];

        this._projects = this._model!.configurations.find((value) => value.name === this.buildType)!.projects;
        this._projectTargets.clear();
        this._targetProjects.clear();

        this._projects.forEach((project) => {
            this._targets.splice(this._targets.length, 0, ...project.targets);
            this._projectTargets.set(project, project.targets);
            project.targets.forEach((target) =>  this._targetProjects.set(target, project));
        });

        if (this._projects.length > 0) {
            this._project = this._projects.find((value) => value.name === this._clientContext.currentProjectName) || this._projects[0];
            this._clientContext.currentProjectName = this._project.name;

            let context = this.currentProjectContext!;
            let targets = this.projectBuildTargets;
            if (targets && targets.length > 0) {
                let target = targets.find((value) => context.currentTargetName === value.name) || targets[0];
                this._target = target;
                context.currentTargetName = target.name;
            } else {
                this._target = undefined;
            }
        } else {
            this._project = undefined;
            this._target = undefined;
        }
    }

    private checkReady() {
        if (this._state === ClientState.BUILDING) {
            throw new Error("Build in progress.");
        }
        if (this._state < ClientState.RUNNING) {
            throw new Error("Not connected to CMake Server.");
        }
    }

    private createConnection(): Promise<void> {
        let socket = new net.Socket();
        let connection = protocol.createProtocolConnection(socket, socket);

        connection.onMessage((msg: protocol.Display) => this.onMessage(msg));
        connection.onSignal((data: protocol.Signal) => this.onSignal(data));
        connection.onProgress((progress: protocol.Progress) => this.onProgress(progress));
        this._hello = new Promise((resolve) => {
            connection.onHello((msg) => {
                this._state = ClientState.RUNNING;
                resolve(msg);
            });
        });

        let cmakePath = vscode.workspace.getConfiguration("cmake", this.uri).get("cmakePath", "cmake");
        let configEnv = vscode.workspace.getConfiguration("cmake", this.uri).get("configurationEnvironment", {});
        let processEnv = process.env;
        let env = { ...processEnv, ...configEnv };
        this._process = child_process.execFile(
            cmakePath,
            ["-E", "server", "--pipe=" + this.pipeName, "--experimental"],
            { env: env }
        );
        this._connection = connection;

        return new Promise((resolve, reject) => {
            let errorHandler = (err: Error) => {
                this._state = ClientState.STOPPED;
                this._process = undefined;
                reject(err);
            };
            this._process!.on("error", errorHandler);
            // Wait some time until cmake server is spawned, the server creates the pipe
            setTimeout(() => {
                socket.connect(this.pipeName);
                socket.on('error', errorHandler);
                socket.on('connect', () => {
                    // Remove promise handlers
                    socket.removeListener('error', errorHandler);
                    this._process!.removeListener('error', errorHandler);

                    socket.on("close", () => {
                        this._state = ClientState.STOPPED;
                        if (this._process) {
                            this._process.kill();
                        }
                    });
                    this._process!.on("exit", (code, signal) => {
                        this._state = ClientState.STOPPED;
                        this._process = undefined;
                    });
                    connection.listen();
                    this._state = ClientState.CONNECTED;
                    resolve();
                });
            }, 500);
        });
    }
    private onProgress(progress: protocol.Progress): void {

    }

    private onSignal(data: protocol.Signal): any {
        if (data.name === "dirty") {
            if (vscode.workspace.getConfiguration("cmake").get("reconfigureOnChange", false) && this._state === ClientState.GENERATED) {
                this.configure().then(() => this.generate()).then(() => this.updateModel());
            }
        }
        // if (data.name === "fileChange") {
        //     let file = data as protocol.FileChangeSignal;
        // }
    }

    private onMessage(msg: protocol.Display) {
        this._console.appendLine(msg.message);
    }

    private handleBuildLine(line: string) {
        for (let matcher of this._matchers) {
            matcher.match(line);
        }
    }
}