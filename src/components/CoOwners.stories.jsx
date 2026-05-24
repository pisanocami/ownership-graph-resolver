export default {
  title: 'Components/CoOwners',
  tags: ['autodocs'],
};

export const BasicCoOwners = () => (
  <div className="co-owners">
    <div className="co-owners-head">
      Additional owners
      <span className="co-owners-sub">· economic / voting stakes beyond parent</span>
    </div>
    <div className="co-owner-row co-owner-parent" title="Parent company">
      <span className="co-owner-icon chip-accent">◈</span>
      <div className="co-owner-main">
        <div className="co-owner-name">Acme Holding Corp</div>
        <div className="co-owner-meta">
          <span className="chip chip-accent">parent</span>
          <span className="chip">majority owner</span>
        </div>
      </div>
      <div className="co-owner-stake mono">consolidates</div>
    </div>
    <div className="co-owner-row" title="Economic beneficiary">
      <span className="co-owner-icon">$</span>
      <div className="co-owner-main">
        <div className="co-owner-name">Investment Fund ABC</div>
        <div className="co-owner-meta">
          <span className="chip">co-owner</span>
          <span className="chip">economic_beneficiary</span>
        </div>
        <div className="co-owner-evidence">Limited partner in fund structure</div>
        <div className="co-owner-source">
          <a href="#" target="_blank">fund-docs.example.com</a>
        </div>
      </div>
      <div className="co-owner-stake mono">30% econ</div>
    </div>
  </div>
);

export const MultipleCoOwners = () => (
  <div className="co-owners">
    <div className="co-owners-head">
      Additional owners
      <span className="co-owners-sub">· (4 co-owners)</span>
    </div>
    <div className="co-owner-row co-owner-parent" title="Parent">
      <span className="co-owner-icon chip-accent">◈</span>
      <div className="co-owner-main">
        <div className="co-owner-name">Parent Corporation</div>
        <div className="co-owner-meta">
          <span className="chip chip-accent">parent</span>
        </div>
      </div>
      <div className="co-owner-stake mono">consolidates</div>
    </div>

    <div className="co-owner-row" title="Voting control">
      <span className="co-owner-icon chip-warning">⚖</span>
      <div className="co-owner-main">
        <div className="co-owner-name">Board Member Trust</div>
        <div className="co-owner-meta">
          <span className="chip">co-owner</span>
          <span className="chip">voting_control</span>
          <span className="chip">trust</span>
        </div>
      </div>
      <div className="co-owner-stake mono">51% vote</div>
    </div>

    <div className="co-owner-row" title="Economic stake">
      <span className="co-owner-icon">$</span>
      <div className="co-owner-main">
        <div className="co-owner-name">Investment Partners LP</div>
        <div className="co-owner-meta">
          <span className="chip">co-owner</span>
          <span className="chip">economic_beneficiary</span>
        </div>
      </div>
      <div className="co-owner-stake mono">20% econ</div>
    </div>

    <div className="co-owner-row" title="Individual">
      <span className="co-owner-icon">◉</span>
      <div className="co-owner-main">
        <div className="co-owner-name">Jane Smith</div>
        <div className="co-owner-meta">
          <span className="chip">co-owner</span>
          <span className="chip">individual</span>
        </div>
        <div className="co-owner-evidence">Founder and major shareholder</div>
      </div>
      <div className="co-owner-stake mono">15% econ</div>
    </div>
  </div>
);

export const EmptyCoOwners = () => (
  <div className="co-owners">
    <div className="co-owners-head">
      Additional owners
      <span className="co-owners-sub">· no additional co-owners</span>
    </div>
    <div className="co-owner-row co-owner-parent" title="Parent">
      <span className="co-owner-icon chip-accent">◈</span>
      <div className="co-owner-main">
        <div className="co-owner-name">Sole Parent Holding</div>
        <div className="co-owner-meta">
          <span className="chip chip-accent">parent</span>
          <span className="chip">100% owner</span>
        </div>
      </div>
      <div className="co-owner-stake mono">100%</div>
    </div>
  </div>
);
