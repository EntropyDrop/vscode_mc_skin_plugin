const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let extensionContext = null;
let activePreviewPanel = null;
let currentPreviewedFile = null;
let fileWatcher = null;
let debounceTimer = null;
let outputChannel = null;

/**
 * Activate the VS Code extension.
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    extensionContext = context;
    outputChannel = vscode.window.createOutputChannel("Minecraft Skin Previewer");
    outputChannel.appendLine("Minecraft Skin Previewer extension is now active.");
    context.subscriptions.push(outputChannel);

    // Register manual preview command (Explorer Context Menu, Editor Title button, command palette)
    let commandDisposable = vscode.commands.registerCommand('mc-skin-preview.preview', function (uri) {
        let filePath = undefined;
        if (uri && uri.fsPath) {
            filePath = uri.fsPath;
        } else {
            filePath = getActiveTabFilePath();
        }

        if (!filePath) {
            vscode.window.showErrorMessage('No file selected for Minecraft Skin preview.');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        if (ext !== '.png') {
            vscode.window.showErrorMessage('Only PNG files are supported for Minecraft Skin preview.');
            return;
        }

        outputChannel.appendLine(`Manually triggered preview for: ${filePath}`);
        showPreview(filePath);
    });
    context.subscriptions.push(commandDisposable);

    // Set up auto-detection listener on tab activation / change
    try {
        if (vscode.window.tabGroups) {
            let activeTabGroupListener = vscode.window.tabGroups.onDidChangeTabGroups(() => {
                triggerAutoPreviewCheck();
            });
            let tabsListener = vscode.window.tabGroups.onDidChangeTabs(() => {
                triggerAutoPreviewCheck();
            });
            context.subscriptions.push(activeTabGroupListener, tabsListener);
        }
    } catch (err) {
        outputChannel.appendLine(`TabGroups API not fully supported: ${err.message}. Fallback to active text editor listener.`);
    }

    // Fallback/additional check on text editor change
    let textEditorListener = vscode.window.onDidChangeActiveTextEditor(() => {
        triggerAutoPreviewCheck();
    });
    context.subscriptions.push(textEditorListener);

    // Check active tab on startup
    triggerAutoPreviewCheck();
}

/**
 * Throttles/debounces checks to avoid excessive system resources
 */
let autoCheckTimer = null;
function triggerAutoPreviewCheck() {
    if (autoCheckTimer) {
        clearTimeout(autoCheckTimer);
    }
    autoCheckTimer = setTimeout(() => {
        const filePath = getActiveTabFilePath();
        outputChannel.appendLine(`Tab check triggered. Active file path: ${filePath}`);
        if (filePath) {
            onTabChanged(filePath);
        }
    }, 150);
}

/**
 * Retrieves the filesystem path of the currently active tab
 */
function getActiveTabFilePath() {
    // Try the tabGroups API first, as it is the most reliable way to find the actually focused tab
    if (vscode.window.tabGroups && vscode.window.tabGroups.activeTabGroup) {
        const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (activeTab && activeTab.input) {
            const input = activeTab.input;
            if (input.uri && input.uri.scheme === 'file') {
                return input.uri.fsPath;
            }
            if (input.resource && input.resource.scheme === 'file') {
                return input.resource.fsPath;
            }
            // Inspect other properties
            for (const key in input) {
                if (input[key] && input[key].scheme === 'file' && typeof input[key].fsPath === 'string') {
                    return input[key].fsPath;
                }
            }
        }
    }
    // Fallback to active text editor if tabGroups is not supported
    if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document) {
        const uri = vscode.window.activeTextEditor.document.uri;
        if (uri && uri.scheme === 'file') {
            return uri.fsPath;
        }
    }
    return null;
}

/**
 * Handles tab change. Runs checks and opens preview if valid.
 */
async function onTabChanged(filePath) {
    if (!filePath || !filePath.endsWith('.png')) {
        return;
    }

    // 1. Fast read dimensions (must be 64x64)
    const dims = getPngDimensions(filePath);
    if (!dims) {
        return; // Not a valid PNG
    }

    if (dims.width !== 64 || dims.height !== 64) {
        // Optional: Support legacy 64x32 skins
        if (dims.width !== 64 || dims.height !== 32) {
            return;
        }
    }

    // 2. Background check: validate skin structure using mc_skin_utils
    const config = vscode.workspace.getConfiguration('mcSkinPreview');
    const pythonPath = config.get('pythonPath') || '';
    
    const result = await validateSkin(filePath, pythonPath);
    if (!result.valid) {
        outputChannel.appendLine(`Image ${path.basename(filePath)} (${dims.width}x${dims.height}) is not a valid Minecraft skin (has transparent holes in base layer). Skipping auto-preview.`);
        return;
    }

    // Double-check race condition: is the user still viewing this file?
    const currentActive = getActiveTabFilePath();
    if (currentActive !== filePath) {
        outputChannel.appendLine(`Active tab changed from ${filePath} to ${currentActive} during validation. Cancelling preview render.`);
        return;
    }

    // 3. Show / update preview
    outputChannel.appendLine(`Automatically opening 3D preview for valid skin: ${filePath} (Model: ${result.model})`);
    showPreview(filePath, result.model);
}

/**
 * Reads PNG header to extract width and height without loading full file
 */
function getPngDimensions(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(24);
        fs.readSync(fd, buffer, 0, 24, 0);
        fs.closeSync(fd);
        
        // Verify PNG signature (first 8 bytes)
        const pngSig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        for (let i = 0; i < 8; i++) {
            if (buffer[i] !== pngSig[i]) {
                return null;
            }
        }
        
        // Extract width and height at offset 16 and 20
        const width = buffer.readUInt32BE(16);
        const height = buffer.readUInt32BE(20);
        return { width, height };
    } catch (err) {
        return null;
    }
}

/**
 * Spawns python to validate base layer opacity and check model type (Steve vs Alex)
 */
function validateSkin(filePath, pythonPath) {
    return new Promise((resolve) => {
        const py = pythonPath || 'python3';
        const pythonCode = `
import sys
import json
from PIL import Image
try:
    from mc_skin_utils.validator import validate_base_layer, is_alex
    img = Image.open(sys.argv[1])
    valid = validate_base_layer(img)
    alex = is_alex(img)
    print(json.dumps({"valid": valid, "model": "slim" if alex else "default"}))
    sys.exit(0)
except Exception as e:
    print(json.dumps({"valid": False, "model": "default", "error": str(e)}))
    sys.exit(2)
`;
        
        // Add pyenv/homebrew paths to PATH env
        const processEnv = { ...process.env };
        const homeDir = process.env.HOME || '/Users/ha';
        const extraPaths = [
            path.join(homeDir, '.pyenv', 'shims'),
            path.join(homeDir, '.local', 'bin'),
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/usr/bin',
            '/bin'
        ];
        processEnv.PATH = extraPaths.concat(processEnv.PATH || '').join(':');

        const proc = cp.spawn(py, ['-c', pythonCode, filePath], { env: processEnv });
        
        let stdoutData = '';
        proc.stdout.on('data', (data) => {
            stdoutData += data.toString();
        });

        proc.on('close', (code) => {
            try {
                const res = JSON.parse(stdoutData.trim());
                resolve(res);
            } catch (err) {
                resolve({ valid: false, model: 'default' });
            }
        });

        proc.on('error', () => {
            resolve({ valid: false, model: 'default' });
        });
    });
}

/**
 * Closes the tab of the given PNG file path
 */
function closePngEditor(filePath) {
    if (!vscode.window.tabGroups) return;
    try {
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                let tabPath = null;
                if (tab.input && tab.input.uri) {
                    tabPath = tab.input.uri.fsPath;
                } else if (tab.input && tab.input.resource) {
                    tabPath = tab.input.resource.fsPath;
                }
                if (tabPath === filePath) {
                    vscode.window.tabGroups.close(tab);
                    outputChannel.appendLine(`Closed PNG editor tab for: ${filePath}`);
                    return;
                }
            }
        }
    } catch (err) {
        outputChannel.appendLine(`Failed to close PNG editor tab: ${err.message}`);
    }
}

/**
 * Creates or updates the Webview panel showing the 3D skin model using Base64 Data URL
 */
function showPreview(filePath, model) {
    currentPreviewedFile = filePath;

    // Load file and convert to Base64 Data URL to bypass image caching and localResourceRoots issues
    let base64Data;
    try {
        const fileBuffer = fs.readFileSync(filePath);
        base64Data = `data:image/png;base64,${fileBuffer.toString('base64')}`;
    } catch (err) {
        outputChannel.appendLine(`Failed to convert skin file to Base64: ${err.message}`);
        return;
    }

    if (activePreviewPanel) {
        // If webview is already open, update the skin image source directly with Base64 data and model type
        activePreviewPanel.title = `3D Skin: ${path.basename(filePath)}`;
        activePreviewPanel.webview.postMessage({
            command: 'updateSkin',
            url: base64Data,
            model: model
        });
    } else {
        // Create a new webview panel beside the active editor
        activePreviewPanel = vscode.window.createWebviewPanel(
            'mcSkinPreview',
            `3D Skin: ${path.basename(filePath)}`,
            {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: true
            },
            {
                enableScripts: true,
                localResourceRoots: [
                    vscode.Uri.file(extensionContext.extensionPath)
                ]
            }
        );

        activePreviewPanel.onDidDispose(() => {
            activePreviewPanel = null;
            if (fileWatcher) {
                fileWatcher.close();
                fileWatcher = null;
            }
            // Close the corresponding PNG editor when preview panel is closed
            closePngEditor(filePath);
        });

        const bundleUri = activePreviewPanel.webview.asWebviewUri(
            vscode.Uri.file(path.join(extensionContext.extensionPath, 'skinview3d.bundle.js'))
        );
        activePreviewPanel.webview.html = getWebviewContent(base64Data, bundleUri, model);
    }

    // Set up file watcher to automatically reload on save
    watchFile(filePath, () => {
        if (activePreviewPanel && currentPreviewedFile === filePath) {
            try {
                const fileBuffer = fs.readFileSync(filePath);
                const updatedBase64 = `data:image/png;base64,${fileBuffer.toString('base64')}`;
                
                // Fetch the updated model type dynamically if the file is modified
                const config = vscode.workspace.getConfiguration('mcSkinPreview');
                const pythonPath = config.get('pythonPath') || '';
                validateSkin(filePath, pythonPath).then(result => {
                    if (activePreviewPanel && currentPreviewedFile === filePath) {
                        activePreviewPanel.webview.postMessage({
                            command: 'updateSkin',
                            url: updatedBase64,
                            model: result.model
                        });
                        outputChannel.appendLine(`Hot-reloaded skin on file modification: ${filePath} (Model: ${result.model})`);
                    }
                });
            } catch (err) {
                outputChannel.appendLine(`Failed to read modified skin: ${err.message}`);
            }
        }
    });
}

/**
 * Sets up a debounced fs file watcher
 */
function watchFile(filePath, callback) {
    if (fileWatcher) {
        fileWatcher.close();
    }
    try {
        fileWatcher = fs.watch(filePath, (eventType) => {
            if (eventType === 'change') {
                if (debounceTimer) {
                    clearTimeout(debounceTimer);
                }
                debounceTimer = setTimeout(callback, 100);
            }
        });
    } catch (err) {
        outputChannel.appendLine(`Failed to watch file changes for ${filePath}: ${err.message}`);
    }
}

/**
 * Generates the HTML content for the Webview utilizing skinview3d
 */
function getWebviewContent(skinUri, bundleUri, model) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: var(--vscode-editor-background, #1e1e1e);
            --fg-color: var(--vscode-editor-foreground, #cccccc);
            --panel-bg: rgba(30, 30, 30, 0.7);
            --border-color: rgba(255, 255, 255, 0.1);
            --accent-color: var(--vscode-button-background, #007acc);
            --accent-hover: var(--vscode-button-hoverBackground, #0062a3);
        }
        
        body {
            margin: 0;
            padding: 0;
            background-color: var(--bg-color);
            color: var(--fg-color);
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            overflow: hidden;
            font-family: 'Outfit', sans-serif;
            user-select: none;
        }

        #canvas-container {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 1;
            cursor: grab;
        }
        #canvas-container:active {
            cursor: grabbing;
        }
        canvas {
            display: block;
        }

        /* Glassmorphism Control Panel */
        #control-panel {
            position: absolute;
            top: 16px;
            right: 16px;
            z-index: 10;
            background: var(--panel-bg);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 16px;
            width: 220px;
            box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            opacity: 1;
            transform: scale(1);
            transform-origin: top right;
            pointer-events: auto;
        }
        
        #control-panel.collapsed {
            opacity: 0;
            transform: scale(0.8);
            pointer-events: none;
        }

        #panel-toggle {
            position: absolute;
            top: 16px;
            right: 16px;
            z-index: 20;
            background: var(--panel-bg);
            backdrop-filter: blur(12px);
            border: 1px solid var(--border-color);
            border-radius: 50%;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0,0,0,0.25);
            color: var(--fg-color);
            font-size: 14px;
            transition: all 0.2s ease;
        }
        #panel-toggle:hover {
            background: rgba(255, 255, 255, 0.1);
            transform: scale(1.05);
        }

        h3 {
            margin: 0 0 12px 0;
            font-size: 13px;
            font-weight: 600;
            letter-spacing: 0.8px;
            text-transform: uppercase;
            opacity: 0.9;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 8px;
        }

        .control-row {
            display: flex;
            flex-direction: column;
            margin-bottom: 10px;
        }

        .control-row label {
            font-size: 11px;
            font-weight: 500;
            margin-bottom: 4px;
            opacity: 0.8;
        }

        select, input[type="range"] {
            background: rgba(0, 0, 0, 0.25);
            border: 1px solid var(--border-color);
            color: var(--fg-color);
            border-radius: 6px;
            padding: 5px 8px;
            font-family: inherit;
            font-size: 11px;
            outline: none;
        }

        select:focus {
            border-color: var(--accent-color);
        }

        .checkbox-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 6px;
            margin-top: 4px;
        }

        .checkbox-label {
            display: flex;
            align-items: center;
            font-size: 10px !important;
            cursor: pointer;
            opacity: 0.9;
        }

        .checkbox-label input {
            margin-right: 4px;
            cursor: pointer;
        }

        #info {
            position: absolute;
            bottom: 16px;
            right: 16px;
            z-index: 10;
            font-size: 11px;
            opacity: 0.5;
            pointer-events: none;
            background: rgba(0, 0, 0, 0.4);
            padding: 4px 8px;
            border-radius: 4px;
        }

        #debug-log {
            position: absolute;
            bottom: 45px;
            left: 16px;
            z-index: 100;
            font-size: 10px;
            color: #ffca28;
            background: rgba(0, 0, 0, 0.7);
            max-height: 120px;
            width: 300px;
            overflow-y: auto;
            pointer-events: auto;
            padding: 8px;
            border-radius: 6px;
            font-family: monospace;
            border: 1px solid rgba(255, 255, 255, 0.05);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            opacity: 1;
            transform: translateY(0);
        }
        
        #debug-log.collapsed {
            opacity: 0;
            transform: translateY(20px);
            pointer-events: none;
        }

        #log-toggle {
            position: absolute;
            bottom: 16px;
            left: 16px;
            z-index: 110;
            background: rgba(30, 30, 30, 0.7);
            backdrop-filter: blur(8px);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 4px 8px;
            font-size: 10px;
            color: var(--fg-color);
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
            transition: all 0.2s ease;
        }
        #log-toggle:hover {
            background: rgba(255, 255, 255, 0.1);
        }
    </style>
</head>
<body>
    <div id="canvas-container"></div>
    <div id="info">Drag to rotate • Scroll to zoom</div>
    
    <!-- Collapsible Debug Log Overlay -->
    <div id="debug-log" class="collapsed">Log Console:</div>
    <button id="log-toggle" title="Toggle Log Console">Logs 📋</button>

    <!-- Collapsible Control Panel Toggle Button -->
    <button id="panel-toggle" title="Toggle Controls">⚙️</button>

    <!-- Collapsible Control Panel -->
    <div id="control-panel" class="collapsed">
        <h3>Skin Viewer</h3>
        
        <div class="control-row">
            <label for="animation-select">Animation</label>
            <select id="animation-select">
                <option value="walk" selected>Walking</option>
                <option value="run">Running</option>
                <option value="fly">Flying</option>
                <option value="idle">Idle</option>
                <option value="none">None</option>
            </select>
        </div>

        <div class="control-row">
            <label for="speed-slider">Speed</label>
            <input type="range" id="speed-slider" min="0.1" max="2.5" step="0.1" value="1.0">
        </div>

        <div class="control-row" style="margin-top: 6px;">
            <label class="checkbox-label">
                <input type="checkbox" id="auto-rotate" checked> Auto Rotate
            </label>
        </div>

        <div class="control-row" style="margin-top: 8px;">
            <label>Outer Layers</label>
            <div class="checkbox-grid">
                <label class="checkbox-label"><input type="checkbox" id="layer-hat" checked> Hat</label>
                <label class="checkbox-label"><input type="checkbox" id="layer-jacket" checked> Jacket</label>
                <label class="checkbox-label"><input type="checkbox" id="layer-left-sleeve" checked> L Sleeve</label>
                <label class="checkbox-label"><input type="checkbox" id="layer-right-sleeve" checked> R Sleeve</label>
                <label class="checkbox-label"><input type="checkbox" id="layer-left-pants" checked> L Pants</label>
                <label class="checkbox-label"><input type="checkbox" id="layer-right-pants" checked> R Pants</label>
            </div>
        </div>
    </div>

    <script src="${bundleUri}"></script>
    <script>
        let viewer;
        const container = document.getElementById("canvas-container");
        const logBox = document.getElementById("debug-log");

        function log(msg) {
            logBox.innerHTML += "<div>[" + new Date().toLocaleTimeString() + "] " + msg + "</div>";
            logBox.scrollTop = logBox.scrollHeight;
        }
        
        function initViewer(skinUrl, modelType) {
            log("initViewer started with model: " + modelType);
            try {
                viewer = new skinview3d.SkinViewer({
                    canvas: document.createElement("canvas"),
                    width: window.innerWidth,
                    height: window.innerHeight,
                    skin: skinUrl,
                    model: modelType
                });
                container.appendChild(viewer.canvas);
                
                // Adjust camera & zoom
                viewer.camera.position.z = 70;
                viewer.zoom = 0.9;
                
                // Add animations
                setAnimation("walk");
                viewer.autoRotate = true;
                viewer.autoRotateSpeed = 1.0;

                // Pause auto-rotation on mouse interact
                container.addEventListener('mousedown', () => {
                    if (viewer) viewer.autoRotate = false;
                    document.getElementById("auto-rotate").checked = false;
                });
                container.addEventListener('touchstart', () => {
                    if (viewer) viewer.autoRotate = false;
                    document.getElementById("auto-rotate").checked = false;
                });

                // Set initial overlay visibility
                updateLayerVisibility();
                log("initViewer completed successfully");
            } catch (err) {
                log("initViewer error: " + err.message);
            }
        }

        initViewer("${skinUri}", "${model}");

        // Animations switcher
        function setAnimation(name) {
            if (!viewer) return;
            
            // Clear current animation
            viewer.animation = null;
            
            const speed = parseFloat(document.getElementById("speed-slider").value);
            
            if (name === "walk") {
                viewer.animation = new skinview3d.WalkingAnimation();
            } else if (name === "run") {
                viewer.animation = new skinview3d.RunningAnimation();
            } else if (name === "fly") {
                viewer.animation = new skinview3d.FlyingAnimation();
            } else if (name === "idle") {
                viewer.animation = new skinview3d.IdleAnimation();
            }
            
            if (viewer.animation) {
                viewer.animation.speed = speed;
            }
        }

        // Layer visibility toggles
        function updateLayerVisibility() {
            if (!viewer || !viewer.playerObject || !viewer.playerObject.skin) {
                log("Warning: playerObject skin not ready");
                return;
            }
            try {
                const skin = viewer.playerObject.skin;
                if (skin.head && skin.head.outerLayer) {
                    skin.head.outerLayer.visible = document.getElementById("layer-hat").checked;
                }
                if (skin.body && skin.body.outerLayer) {
                    skin.body.outerLayer.visible = document.getElementById("layer-jacket").checked;
                }
                if (skin.leftArm && skin.leftArm.outerLayer) {
                    skin.leftArm.outerLayer.visible = document.getElementById("layer-left-sleeve").checked;
                }
                if (skin.rightArm && skin.rightArm.outerLayer) {
                    skin.rightArm.outerLayer.visible = document.getElementById("layer-right-sleeve").checked;
                }
                if (skin.leftLeg && skin.leftLeg.outerLayer) {
                    skin.leftLeg.outerLayer.visible = document.getElementById("layer-left-pants").checked;
                }
                if (skin.rightLeg && skin.rightLeg.outerLayer) {
                    skin.rightLeg.outerLayer.visible = document.getElementById("layer-right-pants").checked;
                }
                log("Layers updated successfully");
            } catch (err) {
                log("Layer update error: " + err.message);
            }
        }

        // Wire UI events
        document.getElementById("animation-select").addEventListener("change", (e) => {
            setAnimation(e.target.value);
        });

        document.getElementById("speed-slider").addEventListener("input", (e) => {
            if (viewer && viewer.animation) {
                viewer.animation.speed = parseFloat(e.target.value);
            }
        });

        document.getElementById("auto-rotate").addEventListener("change", (e) => {
            if (viewer) {
                viewer.autoRotate = e.target.checked;
            }
        });

        const layers = ["layer-hat", "layer-jacket", "layer-left-sleeve", "layer-right-sleeve", "layer-left-pants", "layer-right-pants"];
        layers.forEach(id => {
            document.getElementById(id).addEventListener("change", updateLayerVisibility);
        });

        // Handle window resize
        window.addEventListener('resize', () => {
            if (viewer) {
                viewer.width = window.innerWidth;
                viewer.height = window.innerHeight;
            }
        });

        // Toggle Control Panel
        const panelToggle = document.getElementById("panel-toggle");
        const controlPanel = document.getElementById("control-panel");
        panelToggle.addEventListener("click", () => {
            const isCollapsed = controlPanel.classList.toggle("collapsed");
            panelToggle.innerHTML = isCollapsed ? "⚙️" : "✕";
        });

        // Toggle Log Console
        const logToggle = document.getElementById("log-toggle");
        const debugLog = document.getElementById("debug-log");
        logToggle.addEventListener("click", () => {
            const isCollapsed = debugLog.classList.toggle("collapsed");
            logToggle.style.background = isCollapsed ? "rgba(30, 30, 30, 0.7)" : "rgba(80, 80, 80, 0.7)";
        });

        // Listen for updates from extension
        window.addEventListener('message', event => {
            log("Message received!");
            try {
                const message = event.data;
                log("Command: " + message.command + " | Model: " + message.model);
                if (message.command === 'updateSkin') {
                    if (viewer) {
                        log("Loading new skin texture...");
                        viewer.loadSkin(message.url, { model: message.model });
                        log("loadSkin called");
                    } else {
                        log("Viewer not ready. Initializing...");
                        initViewer(message.url, message.model);
                    }
                }
            } catch (err) {
                log("Message handle error: " + err.message);
            }
        });
    </script>
</body>
</html>`;
}

function deactivate() {
    if (activePreviewPanel) {
        activePreviewPanel.dispose();
    }
    if (fileWatcher) {
        fileWatcher.close();
    }
}

module.exports = {
    activate,
    deactivate
};
