export default {
  title: 'Components/Stepper',
  tags: ['autodocs'],
};

export const ThreeStep = () => (
  <div className="stepper">
    <div className="step done">
      <span className="step-dot">1</span>
      Ownership Analysis
    </div>
    <span className="step-sep"></span>
    <div className="step active">
      <span className="step-dot">2</span>
      Revenue Estimation
    </div>
    <span className="step-sep"></span>
    <div className="step">
      <span className="step-dot">3</span>
      Synthesis
    </div>
  </div>
);

export const AllCompleted = () => (
  <div className="stepper">
    <div className="step done">
      <span className="step-dot">1</span>
      Completed
    </div>
    <span className="step-sep"></span>
    <div className="step done">
      <span className="step-dot">2</span>
      Completed
    </div>
    <span className="step-sep"></span>
    <div className="step done">
      <span className="step-dot">3</span>
      Completed
    </div>
  </div>
);

export const FirstStepActive = () => (
  <div className="stepper">
    <div className="step active">
      <span className="step-dot">1</span>
      In Progress
    </div>
    <span className="step-sep"></span>
    <div className="step">
      <span className="step-dot">2</span>
      Pending
    </div>
    <span className="step-sep"></span>
    <div className="step">
      <span className="step-dot">3</span>
      Pending
    </div>
  </div>
);

export const LongLabels = () => (
  <div className="stepper">
    <div className="step done">
      <span className="step-dot">1</span>
      Tree Resolution
    </div>
    <span className="step-sep"></span>
    <div className="step active">
      <span className="step-dot">2</span>
      Parallel Revenue Inference
    </div>
    <span className="step-sep"></span>
    <div className="step">
      <span className="step-dot">3</span>
      Local Synthesis & Positioning
    </div>
  </div>
);
