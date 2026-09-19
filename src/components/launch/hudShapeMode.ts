let hudShapeMode = false;

/**
 * Set once the renderer learns the window supports X11 shape mode (constant
 * tall window, OS clips paint+input to the reported content rects). Only set
 * on X clients whose Electron has setShape; native Wayland and other
 * platforms keep the legacy fixed-size window and never report shapes.
 */
export function setHudShapeMode(value: boolean): void {
	hudShapeMode = value;
}

export function isHudShapeMode(): boolean {
	return hudShapeMode;
}
