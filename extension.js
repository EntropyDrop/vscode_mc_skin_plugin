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
        if (filePath) {
            onTabChanged(filePath);
        }
    }, 150);
}

/**
 * Retrieves the filesystem path of the currently active tab
 */
function getActiveTabFilePath() {
    // Try to get from active text editor first (handles text documents)
    if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document) {
        const uri = vscode.window.activeTextEditor.document.uri;
        if (uri && uri.scheme === 'file') {
            return uri.fsPath;
        }
    }
    // Fallback to active tab group (handles image/binary editors)
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
    
    const isValid = await validateSkin(filePath, pythonPath);
    if (!isValid) {
        outputChannel.appendLine(`Image ${path.basename(filePath)} (${dims.width}x${dims.height}) is not a valid Minecraft skin (has transparent holes in base layer). Skipping auto-preview.`);
        return;
    }

    // 3. Show / update preview
    outputChannel.appendLine(`Automatically opening 3D preview for valid skin: ${filePath}`);
    showPreview(filePath);
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
 * Spawns python to validate base layer opacity
 */
function validateSkin(filePath, pythonPath) {
    return new Promise((resolve) => {
        const py = pythonPath || 'python3';
        const pythonCode = `
import sys
from PIL import Image
try:
    from mc_skin_utils.validator import validate_base_layer
    img = Image.open(sys.argv[1])
    valid = validate_base_layer(img)
    sys.exit(0 if valid else 1)
except Exception as e:
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
        
        proc.on('close', (code) => {
            resolve(code === 0);
        });

        proc.on('error', () => {
            resolve(false);
        });
    });
}

/**
 * Creates or updates the Webview panel showing the 3D skin model
 */
function showPreview(filePath) {
    currentPreviewedFile = filePath;
    const fileUri = vscode.Uri.file(filePath);

    if (activePreviewPanel) {
        // If webview is already open, update the skin image source
        const webviewSkinUri = activePreviewPanel.webview.asWebviewUri(fileUri);
        const cacheBusterUrl = `${webviewSkinUri.toString()}?t=${Date.now()}`;
        activePreviewPanel.title = `3D Skin: ${path.basename(filePath)}`;
        activePreviewPanel.webview.postMessage({
            command: 'updateSkin',
            url: cacheBusterUrl
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
                    vscode.Uri.file(extensionContext.extensionPath),
                    vscode.Uri.file(os.homedir()),
                    vscode.Uri.file(path.dirname(filePath))
                ]
            }
        );

        activePreviewPanel.onDidDispose(() => {
            activePreviewPanel = null;
            if (fileWatcher) {
                fileWatcher.close();
                fileWatcher = null;
            }
        });

        const webviewSkinUri = activePreviewPanel.webview.asWebviewUri(fileUri);
        const cacheBusterUrl = `${webviewSkinUri.toString()}?t=${Date.now()}`;
        const bundleUri = activePreviewPanel.webview.asWebviewUri(
            vscode.Uri.file(path.join(extensionContext.extensionPath, 'skinview3d.bundle.js'))
        );
        activePreviewPanel.webview.html = getWebviewContent(cacheBusterUrl, bundleUri);
    }

    // Set up file watcher to automatically reload on save
    watchFile(filePath, () => {
        if (activePreviewPanel && currentPreviewedFile === filePath) {
            const webviewSkinUri = activePreviewPanel.webview.asWebviewUri(vscode.Uri.file(filePath));
            const cacheBusterUrl = `${webviewSkinUri.toString()}?t=${Date.now()}`;
            activePreviewPanel.webview.postMessage({
                command: 'updateSkin',
                url: cacheBusterUrl
            });
            outputChannel.appendLine(`Hot-reloaded skin on file modification: ${filePath}`);
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
function getWebviewContent(skinUri, bundleUri) {
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
            transition: all 0.3s ease;
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
            left: 16px;
            z-index: 10;
            font-size: 11px;
            opacity: 0.5;
            pointer-events: none;
            background: rgba(0, 0, 0, 0.4);
            padding: 4px 8px;
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <div id="canvas-container"></div>
    <div id="info">Drag to rotate • Scroll to zoom</div>

    <div id="control-panel">
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
        let rotateAnim;
        const container = document.getElementById("canvas-container");
        
        function initViewer(skinUrl) {
            viewer = new skinview3d.SkinViewer({
                canvas: document.createElement("canvas"),
                width: window.innerWidth,
                height: window.innerHeight,
                skin: skinUrl
            });
            container.appendChild(viewer.canvas);
            
            // Adjust camera & zoom
            viewer.camera.position.z = 70;
            viewer.zoom = 0.9;
            
            // Add animations
            setAnimation("walk");
            rotateAnim = viewer.animations.add(skinview3d.RotatingAnimation);
            rotateAnim.speed = 0.5;

            // Pause auto-rotation on mouse interact
            container.addEventListener('mousedown', () => {
                if (rotateAnim) rotateAnim.paused = true;
                document.getElementById("auto-rotate").checked = false;
            });
            container.addEventListener('touchstart', () => {
                if (rotateAnim) rotateAnim.paused = true;
                document.getElementById("auto-rotate").checked = false;
            });

            // Set initial overlay visibility
            updateLayerVisibility();
        }

        initViewer("${skinUri}");

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
            if (!viewer) return;
            const skin = viewer.playerObject.skin;
            skin.headLayer.visible = document.getElementById("layer-hat").checked;
            skin.bodyLayer.visible = document.getElementById("layer-jacket").checked;
            skin.leftArmLayer.visible = document.getElementById("layer-left-sleeve").checked;
            skin.rightArmLayer.visible = document.getElementById("layer-right-sleeve").checked;
            skin.leftLegLayer.visible = document.getElementById("layer-left-pants").checked;
            skin.rightLegLayer.visible = document.getElementById("layer-right-pants").checked;
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
            if (rotateAnim) {
                rotateAnim.paused = !e.target.checked;
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

        // Listen for updates from extension
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'updateSkin') {
                if (viewer) {
                    viewer.loadSkin(message.url);
                } else {
                    initViewer(message.url);
                }
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
