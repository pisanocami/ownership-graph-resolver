import { BaseEdge, getSmoothStepPath } from 'reactflow';

// C2 — internal_launch_by: a brand the parent created in-house (e.g. Explora
// Journeys launched by MSC Group). Dashed teal, distinct from the coral
// brand-authority edge and the solid primary ownership edge.
export default function LaunchEdge({
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
        style={{ stroke: 'var(--c-teal-400)', strokeWidth: 1.2, strokeDasharray: '4 4' }}
      />
      <text x={labelX} y={labelY - 8} textAnchor="middle" fill="var(--c-teal-400)" fontSize={10} className="react-flow__edge-label">
        internal launch
      </text>
    </>
  );
}
