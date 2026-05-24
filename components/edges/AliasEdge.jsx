import { BaseEdge, getSmoothStepPath } from 'reactflow';

export default function AliasEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
}) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 0,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: 'var(--text-muted)',
          strokeWidth: 1.0,
          strokeDasharray: '2 2',
        }}
      />
      <text
        x={labelX}
        y={labelY - 8}
        textAnchor="middle"
        fill="var(--text-muted)"
        fontSize={10}
        className="react-flow__edge-label"
      >
        geographic alias
      </text>
    </>
  );
}
