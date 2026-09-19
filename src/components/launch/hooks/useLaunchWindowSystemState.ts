import { useEffect, useState } from "react";

export function useLaunchWindowSystemState(
	preparePermissions: (args: { startup?: boolean }) => Promise<unknown>,
) {
	const [hudOverlayMousePassthroughSupported, setHudOverlayMousePassthroughSupported] = useState<
		boolean | null
	>(null);
	const [platform, setPlatform] = useState<string | null>(null);
	// Hidden until known so the picker never flashes on Linux portal sessions.
	const [showSourcePicker, setShowSourcePicker] = useState(false);
	// X clients with setShape: the window is a constant tall rectangle whose
	// paint+input is clipped to the reported content rects. Native Wayland
	// keeps the legacy fixed-size window.
	const [hudShapeSupported, setHudShapeSupported] = useState(false);

	useEffect(() => {
		window.electronAPI?.hudOverlayRendererReady?.();
	}, []);

	useEffect(() => {
		let cancelled = false;
		const loadPlatform = async () => {
			try {
				const nextPlatform = await window.electronAPI.getPlatform();
				if (!cancelled) setPlatform(nextPlatform);
			} catch (error) {
				console.error("Failed to load platform:", error);
			}
		};
		void loadPlatform();
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		const loadSourcePickerVisibility = async () => {
			try {
				const visibility = await window.electronAPI.getSourcePickerVisibility();
				if (!cancelled) setShowSourcePicker(visibility.show);
			} catch {
				// Without an answer the safe default is to show the picker —
				// on portal-less X11 it is the only working capture path.
				if (!cancelled) setShowSourcePicker(true);
			}
		};
		void loadSourcePickerVisibility();
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		const loadShapeMode = async () => {
			try {
				const result = await window.electronAPI.getHudOverlayShapeMode();
				if (!cancelled) setHudShapeSupported(Boolean(result.supported));
			} catch (error) {
				console.error("Failed to load HUD shape mode:", error);
			}
		};
		void loadShapeMode();
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		let cancelled = false;
		const loadSupport = async () => {
			try {
				const result = await window.electronAPI.getHudOverlayMousePassthroughSupported();
				if (!cancelled && result.success) {
					setHudOverlayMousePassthroughSupported(result.supported);
				}
			} catch (error) {
				console.error("Failed to load HUD overlay mouse passthrough support:", error);
			}
		};
		void loadSupport();
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		void preparePermissions({ startup: true });
	}, [preparePermissions]);

	return {
		hudOverlayMousePassthroughSupported,
		platform,
		showSourcePicker,
		hudShapeSupported,
	};
}
