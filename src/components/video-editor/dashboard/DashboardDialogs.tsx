import { removeProjectShareLinks } from "../cloud/projectShareLinks";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

import type { DashboardProps } from "./types";

import type { DashboardModel } from "./useDashboardModel";

export function DashboardDialogs({
	isRaw,
	folders,
	busy,
	confirmDelete,
	setConfirmDelete,
	selected,
	run,
	onDeleteProjects,
	save,
	setSelected,
	setSelecting,
}: Pick<
	DashboardProps & DashboardModel,
	| "isRaw"
	| "folders"
	| "busy"
	| "confirmDelete"
	| "setConfirmDelete"
	| "selected"
	| "run"
	| "onDeleteProjects"
	| "save"
	| "setSelected"
	| "setSelecting"
>) {
	return (
		<>
			<Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>
							{isRaw ? "Remove" : "Delete"} {selected.length}{" "}
							{isRaw ? "raw file" : "project"}
							{selected.length === 1 ? "" : "s"}?
						</DialogTitle>
					</DialogHeader>
					<p className="text-sm text-muted-foreground">
						{isRaw
							? "Remove these files from the library. Original files stay on disk so existing projects keep working."
							: "Project files move to Trash. Source recordings are kept."}
					</p>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setConfirmDelete(false)}>
							Cancel
						</Button>
						<Button
							variant="destructive"
							disabled={busy}
							onClick={() =>
								void run(async () => {
									const deleted = await onDeleteProjects(selected);
									removeProjectShareLinks(deleted);
									save(
										folders.map((f) => ({
											...f,
											paths: f.paths.filter((p) => !deleted.includes(p)),
										})),
									);
									setSelected(selected.filter((p) => !deleted.includes(p)));
									setConfirmDelete(false);
									if (deleted.length === selected.length) setSelecting(false);
								})
							}
						>
							{isRaw ? "Remove from library" : "Move to Trash"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
