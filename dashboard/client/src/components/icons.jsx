// Icônes SVG minimales, inline — pas de dépendance externe pour rester léger.
const base = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
};

export function IconRefresh(props) {
    return (
        <svg {...base} {...props}>
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
        </svg>
    );
}

export function IconPlus(props) {
    return (
        <svg {...base} {...props}>
            <path d="M12 5v14M5 12h14" />
        </svg>
    );
}

export function IconTrash(props) {
    return (
        <svg {...base} {...props}>
            <path d="M3 6h18" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        </svg>
    );
}

export function IconCloudCheck(props) {
    return (
        <svg {...base} {...props}>
            <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10Z" />
            <path d="m9 13 2 2 4-4" />
        </svg>
    );
}

export function IconAlert(props) {
    return (
        <svg {...base} {...props}>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
        </svg>
    );
}

export function IconRadar(props) {
    return (
        <svg {...base} {...props}>
            <path d="M19.07 4.93A10 10 0 0 0 6.99 3.34" />
            <path d="M4 6l16.24 16.24" />
            <path d="M2.51 9.02A10 10 0 0 0 12 22a10 10 0 0 0 9.49-6.9" />
            <circle cx="12" cy="12" r="3" />
        </svg>
    );
}

export function IconRoute(props) {
    return (
        <svg {...base} {...props}>
            <circle cx="6" cy="19" r="3" />
            <circle cx="18" cy="5" r="3" />
            <path d="M9 19h8a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H7a2 2 0 0 1-2-2V7" />
        </svg>
    );
}

export function IconGauge(props) {
    return (
        <svg {...base} {...props}>
            <path d="M12 14 15.5 9" />
            <path d="M3.34 19a10 10 0 1 1 17.32 0" />
        </svg>
    );
}

export function IconSettings(props) {
    return (
        <svg {...base} {...props}>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    );
}

export function IconChevronDown(props) {
    return (
        <svg {...base} {...props}>
            <path d="m6 9 6 6 6-6" />
        </svg>
    );
}

export function IconBell(props) {
    return (
        <svg {...base} {...props}>
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
    );
}

export function IconSearch(props) {
    return (
        <svg {...base} {...props}>
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
        </svg>
    );
}

export function IconHistory(props) {
    return (
        <svg {...base} {...props}>
            <path d="M3 12a9 9 0 1 0 3-6.7" />
            <path d="M3 4v5h5" />
            <path d="M12 7v5l4 2" />
        </svg>
    );
}

export function IconStar(props) {
    return (
        <svg {...base} {...props}>
            <path d="M12 2.5 15.09 8.76 22 9.77l-5 4.87 1.18 6.88L12 18.27l-6.18 3.25L7 14.64 2 9.77l6.91-1.01z" />
        </svg>
    );
}
