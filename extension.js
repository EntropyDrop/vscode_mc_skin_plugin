const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Activate the VS Code extension.
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('vscode-mc-skin-preview extension is now active.');

    let disposable = vscode.commands.registerCommand('mc-skin-preview.preview', function (uri) {
        // Resolve target file path
        let filePath = undefined;
        if (uri && uri.fsPath) {
            filePath = uri.fsPath;
        } else if (vscode.window.activeTextEditor) {
            filePath = vscode.window.activeTextEditor.document.uri.fsPath;
        }

        if (!filePath) {
            vscode.window.showErrorMessage('No file selected for Minecraft Skin preview.');
            return;
        }

        // Validate file extension
        const ext = path.extname(filePath).toLowerCase();
        if (ext !== '.png') {
            vscode.window.showErrorMessage(`Selected file is not a PNG image (extension: ${ext}). Minecraft skins must be PNG format.`);
            return;
        }

        // Get configurations
        const config = vscode.workspace.getConfiguration('mcSkinPreview');
        const previewCommand = config.get('previewCommand') || 'mc_preview';
        const pythonPath = config.get('pythonPath') || '';

        // Prepare environment to ensure pyenv/homebrew paths are available
        const processEnv = { ...process.env };
        const homeDir = process.env.HOME || '/Users/ha';
        
        // Add typical macOS python and shim paths
        const extraPaths = [
            path.join(homeDir, '.pyenv', 'shims'),
            path.join(homeDir, '.local', 'bin'),
            '/opt/homebrew/bin',
            '/usr/local/bin',
            '/usr/bin',
            '/bin',
            '/usr/sbin',
            '/sbin'
        ];

        if (processEnv.PATH) {
            processEnv.PATH = extraPaths.join(':') + ':' + processEnv.PATH;
        } else {
            processEnv.PATH = extraPaths.join(':');
        }

        // Execute command
        vscode.window.showInformationMessage(`Launching Minecraft Skin Preview for: ${path.basename(filePath)}`);

        let child;
        if (pythonPath) {
            // Run via specified python module
            const args = ['-m', 'mc_skin_utils.mc_preview', filePath];
            child = cp.spawn(pythonPath, args, {
                env: processEnv,
                detached: true,
                stdio: 'ignore'
            });
        } else {
            // Run direct executable
            child = cp.spawn(previewCommand, [filePath], {
                env: processEnv,
                detached: true,
                stdio: 'ignore'
            });
        }

        child.unref();

        child.on('error', (err) => {
            vscode.window.showErrorMessage(
                `Failed to run Minecraft Skin Preview command: "${previewCommand}". ` +
                `Ensure that "mc_skin_utils" is installed in your python environment (e.g., run 'pip install -e .' in 'mc_skin_utils'). ` +
                `Error detail: ${err.message}`
            );
        });
    });

    context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
