const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');

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
    if (vscode.window.tabGroups) {
        let activeTabGroupListener = vscode.window.tabGroups.onDidChangeActiveTabGroup(() => {
            triggerAutoPreviewCheck();
        });
        let tabsListener = vscode.window.tabGroups.onDidChangeTabs(() => {
            triggerAutoPreviewCheck();
        });
        context.subscriptions.push(activeTabGroupListener, tabsListener);
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
        if (activeTab && activeTab.input && activeTab.input.uri) {
            return activeTab.input.uri.fsPath;
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
        activePreviewPanel.webview.html = getWebviewContent(cacheBusterUrl);
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
function getWebviewContent(skinUri) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body {
            margin: 0;
            padding: 0;
            background-color: var(--vscode-editor-background, #1e1e1e);
            color: var(--vscode-editor-foreground, #cccccc);
            display: flex;
            flex-direction: column;
            justify-content: center;
            align-items: center;
            height: 100vh;
            overflow: hidden;
            font-family: var(--vscode-font-family, sans-serif);
        }
        #canvas-container {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            cursor: grab;
        }
        #canvas-container:active {
            cursor: grabbing;
        }
        canvas {
            display: block;
        }
        #info {
            position: absolute;
            bottom: 16px;
            font-size: 11px;
            opacity: 0.5;
            pointer-events: none;
            text-align: center;
        }
    </style>
</head>
<body>
    <div id="canvas-container"></div>
    <div id="info">Drag to rotate • Scroll to zoom • Pause rotation on hold</div>

    <script type="module">
        import skinview3d from 'https://cdn.jsdelivr.net/npm/skinview3d@3.4.2/+esm';
        
        let viewer;
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
            viewer.animations.add(skinview3d.WalkingAnimation);
            const rotateAnim = viewer.animations.add(skinview3d.RotatingAnimation);
            rotateAnim.speed = 0.5;

            // Pause auto-rotation on mouse interact
            container.addEventListener('mousedown', () => {
                rotateAnim.paused = true;
            });
            container.addEventListener('touchstart', () => {
                rotateAnim.paused = true;
            });
        }

        initViewer("${skinUri}");

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
