import { BaseEdge, getSmoothStepPath } from 'reactflow';

export default function HistoricalEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
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

  const label = data?.label || 'acquired';

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: 'var(--accent)',
          strokeWidth: 1.5,
          opacity: 0.4,
        }}
      />
      <text
        x={labelX}
        y={labelY - 8}
        textAnchor="middle"
        fill="var(--accent)"
        fontSize={9}
        className="react-flow__edge-label"
        style={{ opacity: 0.6 }}
      >
        {label}
      </text>
    </>
  );
}
