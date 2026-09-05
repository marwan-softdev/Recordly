/*
 * Recordly Linux cursor monitor (X11).
 *
 * Reports cursor position and visual shape on stdout, one line per event,
 * matching the protocol consumed by electron/ipc/cursor/monitor.ts:
 *
 *   STATE:<type>       emitted only when the cursor shape changes
 *   POSITION:<x>:<y>   emitted every poll (root window coordinates)
 *
 * Position comes from XQueryPointer (core X11, always available). The shape
 * is identified by matching the live cursor image (XFixesGetCursorImage)
 * against the theme's standard cursors loaded by libXcursor — this works on
 * any disto regardless of whether libXfixes exports the cursor-name API.
 * Everything is resolved at runtime via dlopen so building only needs core
 * X11 headers plus a C compiler.
 *
 * Reads "stop" (or EOF) on stdin to terminate, like the Windows and macOS
 * helpers.
 */

#include <X11/Xlib.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>

/* ---- Locally declared prototypes for APIs loaded at runtime ---- */

/* From X11/extensions/Xfixes.h */
typedef struct {
	short x;
	short y;
	unsigned short width;
	unsigned short height;
	short xhot;
	short yhot;
	unsigned long cursor_serial;
	unsigned long *pixels;
} RecordlyXFixesCursorImage;

typedef int (*XFixesQueryExtensionFn)(Display *, int *, int *);
typedef RecordlyXFixesCursorImage *(*XFixesGetCursorImageFn)(Display *);

/* From X11/Xcursor.h (all dim fields are uint32_t) */
typedef struct {
	uint32_t version;
	uint32_t size;
	uint32_t width;
	uint32_t height;
	uint32_t xhot;
	uint32_t yhot;
	uint32_t delay;
	uint32_t *pixels;
} RecordlyXcursorImage;

typedef struct {
	int nimage;
	RecordlyXcursorImage **images;
	char *name;
} RecordlyXcursorImages;

typedef RecordlyXcursorImages *(*XcursorLibraryLoadImagesFn)(const char *, const char *, int);
typedef void (*XcursorImagesDestroyFn)(RecordlyXcursorImages *);
typedef char *(*XcursorGetThemeFn)(Display *);

/* Candidate Xcursor library names, mapped to Recordly cursor types. The live
 * cursor image is compared against each of these in order; first pixel-level
 * match wins. */
typedef struct {
	const char *xcursor_name;
	const char *type;
} CursorCandidate;

static const CursorCandidate CURSOR_CANDIDATES[] = {
	{ "left_ptr", "arrow" },
	{ "left_ptr_watch", "arrow" },
	{ "watch", "arrow" },
	{ "xterm", "text" },
	{ "text", "text" },
	{ "hand2", "pointer" },
	{ "hand1", "pointer" },
	{ "pointing_hand", "pointer" },
	{ "cross", "crosshair" },
	{ "cross_reverse", "crosshair" },
	{ "tcross", "crosshair" },
	{ "fleur", "open-hand" },
	{ "all-scroll", "open-hand" },
	{ "grab", "open-hand" },
	{ "grabbing", "closed-hand" },
	{ "closedhand", "closed-hand" },
	{ "sb_h_double_arrow", "resize-ew" },
	{ "h_double_arrow", "resize-ew" },
	{ "ew-resize", "resize-ew" },
	{ "sb_v_double_arrow", "resize-ns" },
	{ "v_double_arrow", "resize-ns" },
	{ "ns-resize", "resize-ns" },
	{ "circle", "not-allowed" },
	{ "forbidden", "not-allowed" },
	{ "no-drop", "not-allowed" },
};

#define CANDIDATE_COUNT (sizeof(CURSOR_CANDIDATES) / sizeof(CURSOR_CANDIDATES[0]))

static volatile bool g_running = true;

static void *stdin_listener(void *unused) {
	(void)unused;
	char line[64];
	while (fgets(line, sizeof(line), stdin) != NULL) {
		if (strncmp(line, "stop", 4) == 0) {
			g_running = false;
			return NULL;
		}
	}
	/* EOF: the parent (Electron) went away. */
	g_running = false;
	return NULL;
}

/* Loaded reference images: CURSOR_CANDIDATES[i] images, or NULL. References
 * are cached per nominal size and reloaded when the live cursor's size
 * changes (e.g. theme or DPI switches). */
static RecordlyXcursorImages *g_references[CANDIDATE_COUNT];
static uint32_t g_reference_size = 0;

/* XFixes returns ARGB pixels, but the array layout varies across libXfixes
 * versions: some pack CARD32s contiguously, others store one pixel per
 * unsigned long. The reference images come from the same theme as the live
 * cursor, so a silhouette match under either layout is unambiguous. */
static uint32_t live_pixel(const RecordlyXFixesCursorImage *live, bool unpacked, size_t index) {
	if (unpacked) {
		return (uint32_t)live->pixels[index];
	}
	return ((const uint32_t *)live->pixels)[index];
}

static bool silhouette_matches(const RecordlyXFixesCursorImage *live, const RecordlyXcursorImage *ref,
							   bool unpacked) {
	if (live->width != ref->width || live->height != ref->height) {
		return false;
	}
	/* Hotspots disambiguate cursors with identical silhouettes but different
	 * anchors (e.g. left_ptr vs bottom_left_corner). */
	if ((uint32_t)live->xhot != ref->xhot || (uint32_t)live->yhot != ref->yhot) {
		return false;
	}
	/* Compare alpha only: apps may recolor cursors (e.g. a white I-beam over
	 * dark terminals), and the server stores premultiplied ARGB while
	 * Xcursor images use straight alpha. */
	size_t count = (size_t)live->width * live->height;
	for (size_t i = 0; i < count; i++) {
		if ((live_pixel(live, unpacked, i) >> 24) != (ref->pixels[i] >> 24)) {
			return false;
		}
	}
	return true;
}

static const char *cursor_type_for_image(const RecordlyXFixesCursorImage *live) {
	for (size_t i = 0; i < CANDIDATE_COUNT; i++) {
		const RecordlyXcursorImages *refs = g_references[i];
		if (refs == NULL) {
			continue;
		}
		for (int j = 0; j < refs->nimage; j++) {
			if (silhouette_matches(live, refs->images[j], false) ||
				silhouette_matches(live, refs->images[j], true)) {
				return CURSOR_CANDIDATES[i].type;
			}
		}
	}
	return "arrow";
}

static void free_reference_cursors(XcursorImagesDestroyFn destroy_images) {
	for (size_t i = 0; i < CANDIDATE_COUNT; i++) {
		if (g_references[i] != NULL && destroy_images != NULL) {
			destroy_images(g_references[i]);
		}
		g_references[i] = NULL;
	}
}

static void load_reference_cursors(Display *display, uint32_t size,
								   XcursorLibraryLoadImagesFn load_images,
								   XcursorImagesDestroyFn destroy_images,
								   XcursorGetThemeFn get_theme) {
	if (size == 0 || size == g_reference_size) {
		return;
	}
	free_reference_cursors(destroy_images);

	char *theme = get_theme != NULL ? get_theme(display) : NULL;

	for (size_t i = 0; i < CANDIDATE_COUNT; i++) {
		g_references[i] = load_images(CURSOR_CANDIDATES[i].xcursor_name, theme, (int)size);
	}

	if (theme != NULL) {
		XFree(theme);
	}
	g_reference_size = size;
}

int main(void) {
	setvbuf(stdout, NULL, _IONBF, 0);

	Display *display = XOpenDisplay(NULL);
	if (display == NULL) {
		/* No X server (e.g. Wayland without XWayland): exit so the
		 * TypeScript side falls back to "arrow" and uiohook positions. */
		fprintf(stderr, "cursor-monitor: cannot open X display\n");
		return 1;
	}

	int event_base = 0;
	int error_base = 0;
	XFixesQueryExtensionFn query_extension = NULL;
	XFixesGetCursorImageFn get_cursor_image = NULL;
	XcursorLibraryLoadImagesFn load_images = NULL;
	XcursorImagesDestroyFn destroy_images = NULL;
	XcursorGetThemeFn get_theme = NULL;

	void *xfixes = dlopen("libXfixes.so.3", RTLD_NOW | RTLD_GLOBAL);
	if (xfixes == NULL) {
		xfixes = dlopen("libXfixes.so", RTLD_NOW | RTLD_GLOBAL);
	}
	if (xfixes != NULL) {
		query_extension = (XFixesQueryExtensionFn)dlsym(xfixes, "XFixesQueryExtension");
		get_cursor_image = (XFixesGetCursorImageFn)dlsym(xfixes, "XFixesGetCursorImage");
	}
	if (query_extension == NULL || get_cursor_image == NULL ||
		!query_extension(display, &event_base, &error_base)) {
		/* Position tracking still works without XFixes; shape stays "arrow". */
		get_cursor_image = NULL;
	}

	void *xcursor = dlopen("libXcursor.so.1", RTLD_NOW | RTLD_GLOBAL);
	if (xcursor == NULL) {
		xcursor = dlopen("libXcursor.so", RTLD_NOW | RTLD_GLOBAL);
	}
	if (xcursor != NULL) {
		load_images = (XcursorLibraryLoadImagesFn)dlsym(xcursor, "XcursorLibraryLoadImages");
		destroy_images = (XcursorImagesDestroyFn)dlsym(xcursor, "XcursorImagesDestroy");
		get_theme = (XcursorGetThemeFn)dlsym(xcursor, "XcursorGetTheme");
	}
	if (load_images == NULL || destroy_images == NULL) {
		load_images = NULL;
		destroy_images = NULL;
	}

	pthread_t listener;
	if (pthread_create(&listener, NULL, stdin_listener, NULL) != 0) {
		fprintf(stderr, "cursor-monitor: cannot start stdin listener\n");
		free_reference_cursors(destroy_images);
		XCloseDisplay(display);
		return 1;
	}
	pthread_detach(listener);

	const char *last_type = "";

	while (g_running) {
		Window root_return = None;
		Window child_return = None;
		int root_x = 0;
		int root_y = 0;
		int win_x = 0;
		int win_y = 0;
		unsigned int mask = 0;
		Bool pointer_ok =
			XQueryPointer(display, DefaultRootWindow(display), &root_return, &child_return,
				&root_x, &root_y, &win_x, &win_y, &mask);

		if (pointer_ok) {
			printf("POSITION:%d:%d\n", root_x, root_y);
		}

		if (get_cursor_image != NULL) {
			RecordlyXFixesCursorImage *image = get_cursor_image(display);
			if (image != NULL) {
				const char *type = "arrow";
				if (load_images != NULL) {
					/* Reload references if the cursor size changed (theme/DPI). */
					load_reference_cursors(display, image->width, load_images, destroy_images,
						get_theme);
					type = cursor_type_for_image(image);
				}
				if (strcmp(type, last_type) != 0) {
					last_type = type;
					printf("STATE:%s\n", type);
				}
				XFree(image);
			}
		}

		usleep(50 * 1000); /* 50 ms, matching the Windows helper cadence. */
	}

	free_reference_cursors(destroy_images);
	XCloseDisplay(display);
	return 0;
}
