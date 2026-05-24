import { BaseEdge, getSmoothStepPath } from 'reactflow';

export default function ControlEdge({
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

  const stakeLabel = data?.stake_pct ? `${data.stake_pct}%` : 'controlling';

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          stroke: 'var(--accent)',
          strokeWidth: 1.2,
          strokeDasharray: '4 4',
        }}
      />
      <g transform={`translate(${labelX}, ${labelY - 12})`}>
        <rect
          x={-18}
          y={-8}
          width={36}
          height={16}
          rx={4}
          fill="var(--accent)"
          opacity={0.1}
          stroke="var(--accent)"
          strokeWidth={0.5}
        />
        <text
          textAnchor="middle"
          y={4}
          fill="var(--accent)"
          fontSize={10}
          fontWeight={600}
        >
          {stakeLabel}
        </text>
      </g>
    </>
  );
}
