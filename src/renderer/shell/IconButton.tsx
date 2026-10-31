/** A square icon button with a tooltip, the unit of every toolbar. */
export function IconButton({
	label,
	onClick,
	active = false,
	disabled = false,
	children,
	className = "",
}: {
	readonly label: string;
	readonly onClick: () => void;
	readonly active?: boolean;
	readonly disabled?: boolean;
	readonly children: React.ReactNode;
	readonly className?: string;
}): React.JSX.Element {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			disabled={disabled}
			onClick={onClick}
			className={`flex h-7 w-7 items-center justify-center transition-colors disabled:opacity-30 ${
				active ? "text-red" : "text-muted hover:text-text"
			} ${className}`}
		>
			{children}
		</button>
	);
}
