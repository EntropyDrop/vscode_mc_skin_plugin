# Minecraft Skin 3D Previewer (VS Code Extension)

This extension provides interactive 3D previews for Minecraft skin PNG files directly from VS Code.

## Features

- Right-click any `.png` skin file in the file explorer and select **"Preview Minecraft Skin (3D)"**.
- Click the **3D icon** in the Editor title bar when viewing a skin PNG file.
- Opens an interactive, responsive PyVista window allowing you to rotate, pan, and zoom the skin with your mouse.
- Supports voxel-based double-layer (armor/decor) rendering with default Minecraft coordinates.

## Requirements

The extension uses the python CLI tool `mc_preview` provided by the `mc_skin_utils` package.

Ensure `mc_skin_utils` is installed in your python environment:
```bash
cd mc_skin_utils
pip install -e .
```

## Configuration

You can customize the command or python path in VS Code settings:

* `mcSkinPreview.previewCommand`: The name or path of the executable (defaults to `mc_preview`).
* `mcSkinPreview.pythonPath`: Optional path to the python interpreter if you want to run it directly via `python -m mc_skin_utils.mc_preview`.

## License

MIT
