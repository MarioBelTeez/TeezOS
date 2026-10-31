import { DEFAULT_MODULES } from "../../../shared/modules.ts";
import { useSettings } from "../../state/settings.ts";
import { Button, EnabledRow, NumberField, Row, Section, Segmented, Toggle } from "./controls.tsx";

/** The Brain: the graph's physics, its labels and colours. The graph follows while it is open. */
export function BrainPage(): React.JSX.Element | null {
	const brain = useSettings((s) => s.settings?.modules.brain);
	const setModules = useSettings((s) => s.setModules);
	if (!brain) return null;
	const defaults = DEFAULT_MODULES.brain;
	const isDefault = brain.repel === defaults.repel && brain.linkDistance === defaults.linkDistance && brain.gravity === defaults.gravity;
	return (
		<>
			<Section title="Brain">
				<EnabledRow module="brain" what="the Brain" />
			</Section>
			<Section title="Graph">
				<Row label="Repel" hint="How hard notes push each other apart.">
					<NumberField label="Repel" value={brain.repel} min={30} max={800} step={10} onChange={(repel) => setModules({ brain: { repel } })} />
				</Row>
				<Row label="Link distance" hint="How long a link likes to be.">
					<NumberField label="Link distance" value={brain.linkDistance} min={20} max={250} step={5} onChange={(linkDistance) => setModules({ brain: { linkDistance } })} />
				</Row>
				<Row label="Gravity" hint="How strongly everything is pulled to the middle.">
					<NumberField label="Gravity" value={brain.gravity} min={0} max={0.5} step={0.01} onChange={(gravity) => setModules({ brain: { gravity } })} />
				</Row>
				<Row label="Physics">
					<Button disabled={isDefault} onClick={() => setModules({ brain: { repel: defaults.repel, linkDistance: defaults.linkDistance, gravity: defaults.gravity } })}>
						Back to the defaults
					</Button>
				</Row>
				<Row label="Labels" hint="Note names on the graph.">
					<Segmented
						value={brain.labels}
						options={[
							{ id: "always", label: "Always" },
							{ id: "zoom", label: "On zoom" },
							{ id: "never", label: "Never" },
						]}
						onChange={(id) => setModules({ brain: { labels: id === "always" || id === "never" ? id : "zoom" } })}
					/>
				</Row>
				<Row label="Colour by folder" hint="Off: every note the same colour.">
					<Toggle value={brain.colorByFolder} label="Colour by folder" onChange={(colorByFolder) => setModules({ brain: { colorByFolder } })} />
				</Row>
			</Section>
		</>
	);
}
