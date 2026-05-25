import { BaseEdge, getSmoothStepPath } from 'reactflow';

// C2 — stewardship: a steward-ownership structure (e.g. Patagonia → Holdfast
// Collective / Purpose Trust) where control is held in trust rather than a
// conventional ownership chain. Dotted sage green, visually distinct so TC-6
// reads as "not a normal parent".
export default function StewardshipEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd,
}) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 0,
  });
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{ stroke: 'var(--c-sage-500)', strokeWidth: 1.2, strokeDasharray: '1 3' }}
      />
      <text x={labelX} y={labelY - 8} textAnchor="middle" fill="var(--c-sage-500)" fontSize={10} className="react-flow__edge-label">
        stewardship
      </text>
    </>
  );
}
