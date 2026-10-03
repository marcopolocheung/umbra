import { useEffect, useRef, useState } from "react";
import {
	type ChronolocationResult,
	type MarksError,
	type PhotoFrame,
	type ShadowMarks,
	observeShadow,
	solveChronolocation,
} from "../lib/chronolocation/solver";
import {
	MARK_LABELS,
	MARK_ORDER,
	type MarkSlot,
	describeResult,
	hasAllMarks,
	nearestMarkSlot,
	nextMarkSlot,
	pixelFromClick,
} from "../lib/chronolocation/panel";
import Kicker from "./ui/Kicker";

interface ChronolocationPanelProps {
	open: boolean;
	onClose: () => void;
	/** Map centre as [lat, lng] (the app's convention); the photo's location. */
	mapCenter: [number, number];
	/** Map-local UTC offset in minutes, for the date labels. */
	utcOffsetMin: number;
}

const DEFAULT_HFOV_DEG = 67;
const focusClass =
	"focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-current";
const fieldClass =
	"min-h-11 w-full border-2 px-2 py-1 text-sm tabular-nums";
const fieldStyle = {
	background: "var(--color-panel)",
	borderColor: "var(--color-rule)",
	color: "var(--color-ink)",
} as const;

const MARK_DOT: Record<MarkSlot, string> = {
	top: "var(--color-sun-signal)",
	base: "var(--color-ink)",
	shadowTip: "var(--color-shade)",
};

/**
 * S4b — date and time a photo from its shadows. Pin where it was taken (the map
 * centre), mark the object's top, base and shadow tip, and the S4a solver runs
 * Umbra's own sun model in reverse. It returns windows of days and a band of
 * minutes, or abstains. The field evaluation is outstanding.
 */
export default function ChronolocationPanel({
	open,
	onClose,
	mapCenter,
	utcOffsetMin,
}: ChronolocationPanelProps) {
	const [photoUrl, setPhotoUrl] = useState<string | null>(null);
	const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
	const [marks, setMarks] = useState<Partial<ShadowMarks>>({});
	const [heading, setHeading] = useState("");
	const [hfov, setHfov] = useState(String(DEFAULT_HFOV_DEG));
	const [result, setResult] = useState<ChronolocationResult | { error: MarksError } | null>(null);
	const urlRef = useRef<string | null>(null);

	useEffect(
		() => () => {
			if (urlRef.current) URL.revokeObjectURL(urlRef.current);
		},
		[],
	);

	const activeSlot = nextMarkSlot(marks);
	const allMarks = hasAllMarks(marks);
	const headingDeg = Number(heading);
	const ready =
		allMarks && natural !== null && heading.trim() !== "" && Number.isFinite(headingDeg);

	function pickPhoto(file: File | null) {
		if (urlRef.current) URL.revokeObjectURL(urlRef.current);
		const url = file ? URL.createObjectURL(file) : null;
		urlRef.current = url;
		setPhotoUrl(url);
		setNatural(null);
		setMarks({});
		setResult(null);
	}

	function setMark(slot: MarkSlot, point: { x: number; y: number }) {
		setMarks((prev) => ({ ...prev, [slot]: point }));
		setResult(null);
	}

	function onPhotoClick(event: React.MouseEvent<HTMLElement>) {
		if (!natural) return;
		// A keyboard activation (Enter/Space) reports detail 0 and no coordinates;
		// the numeric fields are the keyboard path, so a tap only places marks.
		if (event.detail === 0) return;
		const rect = event.currentTarget.getBoundingClientRect();
		const point = pixelFromClick(rect, natural, event.clientX, event.clientY);
		setMark(allMarks ? nearestMarkSlot(marks as ShadowMarks, point) : activeSlot, point);
	}

	function solve() {
		if (!natural || !allMarks) return;
		const parsedHfov = Number(hfov);
		const frame: PhotoFrame = {
			headingDeg,
			hfovDeg: Number.isFinite(parsedHfov) && parsedHfov > 0 ? parsedHfov : DEFAULT_HFOV_DEG,
			widthPx: natural.width,
		};
		const observation = observeShadow(marks, frame);
		if ("error" in observation) {
			setResult(observation);
			return;
		}
		const [lat, lng] = mapCenter;
		setResult(
			solveChronolocation(observation, {
				year: new Date().getFullYear(),
				tzOffsetMin: utcOffsetMin,
				lng,
				lat,
			}),
		);
	}

	const lines = result ? describeResult(result, new Date().getFullYear(), utcOffsetMin) : [];

	return (
		<section
			aria-label="Photo chronolocation"
			className={`umbra-rise-in fixed z-50 flex-col overflow-hidden border-2 shadow-hard-2 ${open ? "flex" : "hidden"}`}
			style={{
				bottom: "1rem",
				left: "1rem",
				width: "min(420px, calc(100vw - 2rem))",
				maxHeight: "min(620px, calc(100vh - 2rem))",
				background: "var(--color-panel)",
				borderColor: "var(--color-ink)",
				color: "var(--color-ink)",
				fontFamily: "var(--font-sans)",
			}}
		>
			<header
				className="flex min-h-14 items-center gap-1 border-b-2 px-2"
				style={{
					background: "var(--color-ink)",
					color: "var(--color-on-ink)",
					borderColor: "var(--color-panel)",
				}}
			>
				<div className="min-w-0 flex-1 px-2">
					<h2
						className="font-extrabold uppercase tracking-wider"
						style={{ fontFamily: "var(--font-label)", fontSize: "var(--text-caption)" }}
					>
						Photo time
					</h2>
					<p className="truncate" style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-caption)" }}>
						Date a photo from its shadows
					</p>
				</div>
				<button
					type="button"
					onClick={onClose}
					aria-label="Close photo time"
					title="Close"
					className={`flex h-11 w-11 shrink-0 items-center justify-center ${focusClass}`}
				>
					<span className="material-symbols-outlined text-xl" aria-hidden="true">close</span>
				</button>
			</header>

			<div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
				<div className="flex flex-col gap-1">
					<Kicker>One photo</Kicker>
					<p className="text-sm" style={{ color: "var(--color-ink-muted)" }}>
						Mark the object&apos;s top, its base, and the far end of its shadow. The sun
						model runs in reverse to date the shot.
					</p>
				</div>

				<label className="flex flex-col gap-1 text-[11px]" style={{ color: "var(--color-ink-muted)" }}>
					Photo
					<input
						type="file"
						accept="image/*"
						onChange={(event) => pickPhoto(event.target.files?.[0] ?? null)}
						className={`min-h-11 w-full border-2 px-2 py-1 text-sm ${focusClass}`}
						style={fieldStyle}
					/>
				</label>

				{photoUrl && (
					<button
						type="button"
						onClick={onPhotoClick}
						aria-label={`Place marks on the photo. Next tap sets ${MARK_LABELS[activeSlot]}.`}
						className={`relative block w-full border-2 p-0 ${focusClass}`}
						style={{ borderColor: "var(--color-ink)" }}
					>
						<img
							src={photoUrl}
							alt=""
							onLoad={(event) =>
								setNatural({
									width: event.currentTarget.naturalWidth,
									height: event.currentTarget.naturalHeight,
								})
							}
							className="pointer-events-none block w-full"
						/>
						{natural &&
							MARK_ORDER.map((slot) => {
								const point = marks[slot];
								if (!point) return null;
								return (
									<span
										key={slot}
										aria-hidden="true"
										className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
										style={{
											left: `${(point.x / natural.width) * 100}%`,
											top: `${(point.y / natural.height) * 100}%`,
											background: MARK_DOT[slot],
											borderColor: "var(--color-panel)",
										}}
									/>
								);
							})}
					</button>
				)}

				{photoUrl && natural && (
					<p className="text-[11px]" role="status" style={{ color: "var(--color-ink-muted)" }}>
						{allMarks
							? "All three marks set — tap a mark to move it."
							: `Next tap sets ${MARK_LABELS[activeSlot]}.`}
					</p>
				)}

				{photoUrl && (
					<div className="flex flex-col gap-2">
						<div className="flex gap-2">
							<label className="flex flex-1 flex-col gap-1 text-[11px]" style={{ color: "var(--color-ink-muted)" }}>
								Camera heading (° from N)
								<input
									type="number"
									inputMode="numeric"
									value={heading}
									onChange={(event) => setHeading(event.target.value)}
									className={`${fieldClass} ${focusClass}`}
									style={fieldStyle}
								/>
							</label>
							<label className="flex w-24 flex-col gap-1 text-[11px]" style={{ color: "var(--color-ink-muted)" }}>
								Horiz. FOV (°)
								<input
									type="number"
									inputMode="numeric"
									value={hfov}
									onChange={(event) => setHfov(event.target.value)}
									className={`${fieldClass} ${focusClass}`}
									style={fieldStyle}
								/>
							</label>
						</div>
						{/* Marks are pointer-placed on the photo; these fields give the
						    same marks a keyboard-and-precision path. */}
						<details className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>
							<summary className={`min-h-11 cursor-pointer ${focusClass}`}>Adjust marks by number</summary>
							<div className="mt-2 flex flex-col gap-2">
								{MARK_ORDER.map((slot) => (
									<div key={slot} className="flex items-center gap-2">
										<span className="w-28 shrink-0">{MARK_LABELS[slot]}</span>
										{(["x", "y"] as const).map((axis) => (
											<input
												key={axis}
												type="number"
												inputMode="numeric"
												aria-label={`${MARK_LABELS[slot]} ${axis} pixel`}
												value={marks[slot]?.[axis] ?? ""}
												onChange={(event) => {
													if (!natural) return;
													const raw = event.target.value;
													// Clearing a field removes the mark, so a half-typed
													// coordinate never becomes a silent 0.
													if (raw === "") {
														setMarks((prev) => {
															const next = { ...prev };
															delete next[slot];
															return next;
														});
														setResult(null);
														return;
													}
													const value = Number(raw);
													if (!Number.isFinite(value)) return;
													const limit = axis === "x" ? natural.width : natural.height;
													const current = marks[slot] ?? { x: 0, y: 0 };
													setMark(slot, { ...current, [axis]: Math.min(limit, Math.max(0, value)) });
												}}
												className={`${fieldClass} ${focusClass}`}
												style={fieldStyle}
											/>
										))}
									</div>
								))}
							</div>
						</details>
						<p className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>
							Location: the map centre ({mapCenter[0].toFixed(4)}, {mapCenter[1].toFixed(4)}).
							Pan the map to the photo&apos;s spot first.
						</p>
					</div>
				)}

				<button
					type="button"
					onClick={solve}
					disabled={!ready}
					className={`min-h-11 border-2 px-3 text-sm font-semibold disabled:opacity-40 ${focusClass}`}
					style={{ background: "var(--color-ink)", color: "var(--color-on-ink)", borderColor: "var(--color-ink)" }}
				>
					Date this photo
				</button>

				{lines.length > 0 && (
					<div
						className="border-2 px-3 py-2 text-sm"
						style={{ background: "var(--color-ground)", borderColor: "var(--color-ink)" }}
						role="status"
						aria-live="polite"
					>
						{lines.map((line) => (
							<p key={line} className="py-0.5">{line}</p>
						))}
					</div>
				)}

				<p className="text-[11px]" style={{ color: "var(--color-ink-muted)" }}>
					A single shadow dates a photo to a window of days, not one day, and a band of
					minutes. Mark a near, prominent object on flat ground. The field evaluation
					against a real photo set is outstanding.
				</p>
			</div>
		</section>
	);
}
