export default {
  title: 'Components/TreeNode',
  tags: ['autodocs'],
};

export const DefaultNode = () => (
  <div className="tree-node">
    <div className="tree-node-main">
      <span className="tree-node-name">Acme Corporation</span>
      <div className="tree-node-meta">
        <span>Public Company</span>
      </div>
    </div>
    <span className="tree-node-rev">$100B</span>
  </div>
);

export const FocalNode = () => (
  <div className="tree-node focal">
    <div className="tree-node-main">
      <span className="tree-node-name">Target Company</span>
      <div className="tree-node-meta">
        <span>Focal Entity</span>
      </div>
    </div>
    <span className="tree-node-rev">$50B</span>
  </div>
);

export const IndividualNode = () => (
  <div className="tree-node individual">
    <span className="ubo-icon">👤</span>
    <div className="tree-node-main">
      <span className="tree-node-name">John Smith</span>
      <div className="tree-node-meta">
        <span>Individual Owner</span>
      </div>
    </div>
    <span className="tree-node-rev">—</span>
  </div>
);

export const SelectedNode = () => (
  <div className="tree-node selected">
    <div className="tree-node-main">
      <span className="tree-node-name">Selected Entity</span>
      <div className="tree-node-meta">
        <span>Currently Selected</span>
      </div>
    </div>
    <span className="tree-node-rev">$25B</span>
  </div>
);

export const TreeNodeGrid = () => (
  <div>
    <div className="tree-section-label">Parents</div>
    <div className="tree-grid">
      <div className="tree-node focal">
        <div className="tree-node-main">
          <span className="tree-node-name">Acme Corp</span>
          <div className="tree-node-meta">
            <span>Public</span>
          </div>
        </div>
        <span className="tree-node-rev">$100B</span>
      </div>
      <div className="tree-node">
        <div className="tree-node-main">
          <span className="tree-node-name">Parent Co</span>
          <div className="tree-node-meta">
            <span>Private</span>
          </div>
        </div>
        <span className="tree-node-rev">$50B</span>
      </div>
      <div className="tree-node individual">
        <span className="ubo-icon">👤</span>
        <div className="tree-node-main">
          <span className="tree-node-name">Jane Doe</span>
          <div className="tree-node-meta">
            <span>Individual</span>
          </div>
        </div>
        <span className="tree-node-rev">—</span>
      </div>
    </div>
  </div>
);

export const FlowNode = () => (
  <div className="flow-node focal">
    <div className="flow-node-name">Target Company Inc</div>
    <div className="flow-node-domain">target.example.com</div>
    <div className="flow-node-meta">
      <span className="chip chip-accent">focal</span>
    </div>
  </div>
);

export const FlowNodeVariants = () => (
  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
    <div className="flow-node">
      <div className="flow-node-name">Standard Company</div>
      <div className="flow-node-domain">company.com</div>
    </div>
    <div className="flow-node focal">
      <div className="flow-node-name">Target Company</div>
      <div className="flow-node-domain">target.com</div>
    </div>
    <div className="flow-node individual">
      <div className="flow-node-name">John Smith</div>
      <div className="flow-node-domain">individual</div>
    </div>
  </div>
);
