import {
  ArrowDown,
  ArrowRight,
  BarChart3,
  BrainCircuit,
  Database,
  Sparkles,
  UsersRound,
} from 'lucide-react';
import { Logo } from './App';

const roadmap = [
  {
    number: '01',
    title: 'Expand the evidence',
    body: 'Grow the historical evaluation dataset across more markets and more outcomes.',
    icon: Database,
    className: 'lime',
  },
  {
    number: '02',
    title: 'Add more perspectives',
    body: 'Introduce additional quantitative models to make every comparison more useful.',
    icon: BrainCircuit,
    className: 'violet',
  },
  {
    number: '03',
    title: 'Learn with real users',
    body: 'Test DreamCurve with real users and turn their feedback into a clearer experience.',
    icon: UsersRound,
    className: 'blue',
  },
] as const;

function RoadmapVisual() {
  return (
    <div className="future-orbit" aria-label="Three future initiatives converging on a clearer DreamCurve experience" role="img">
      <div className="future-grid" />
      <div className="future-ring future-ring-one" />
      <div className="future-ring future-ring-two" />
      <div className="future-core">
        <span className="brand-mark"><BarChart3 size={26} strokeWidth={2.6} /></span>
        <small>DREAMCURVE</small>
        <strong>Next</strong>
        <span>From insight to understanding</span>
      </div>
      {roadmap.map(({ number, title, icon: Icon, className }) => (
        <div className={`future-node future-node-${number} ${className}`} key={number}>
          <Icon size={17} />
          <span>{title}</span>
        </div>
      ))}
    </div>
  );
}

export default function PresentationPage() {
  return (
    <div className="presentation-page">
      <header className="landing-header wrap presentation-header">
        <Logo />
        <div className="presentation-chapter"><span>17</span> Future version</div>
        <a className="button dark small" href="#closing">Closing <ArrowDown size={15} /></a>
      </header>

      <main id="main-content" tabIndex={-1}>
        <section className="future-hero wrap">
          <div className="future-copy">
            <span className="eyebrow"><span className="status-dot" /> THE NEXT CHAPTER</span>
            <h1>Looking ahead,<br />we’re just getting <span className="edge-word">started<svg viewBox="0 0 330 30" aria-hidden="true"><path d="M4 18Q130 1 320 12M30 27Q180 7 302 23" /></svg></span>.</h1>
            <p>Our next version will deepen the evidence, broaden the models, and bring real users into the process.</p>
            <a href="#roadmap" className="text-link">Explore the roadmap <ArrowDown size={17} /></a>
          </div>
          <RoadmapVisual />
        </section>

        <div className="future-strip">
          <div className="wrap">
            <span>BUILD</span><ArrowRight size={15} /><span>MEASURE</span><ArrowRight size={15} /><span>LEARN</span>
            <strong>One clearer experience.</strong>
          </div>
        </div>

        <section className="roadmap-section wrap" id="roadmap">
          <div className="section-heading">
            <div>
              <span className="eyebrow">FROM PROTOTYPE TO PRODUCT</span>
              <h2>Three steps.<br />One direction.</h2>
            </div>
            <p>Every next step helps turn transparent<br />predictions into practical understanding.</p>
          </div>
          <div className="future-cards">
            {roadmap.map(({ number, title, body, icon: Icon, className }) => (
              <article className={`future-card ${className}`} key={number}>
                <div className="future-card-top">
                  <span className="future-card-icon"><Icon size={25} strokeWidth={1.8} /></span>
                  <span className="future-card-number">{number} / 03</span>
                </div>
                <h3>{title}</h3>
                <p>{body}</p>
                <div className="future-card-signal"><span /><span /><span /><span /><span /></div>
              </article>
            ))}
          </div>
        </section>

        <section className="future-impact">
          <div className="wrap impact-layout">
            <div className="impact-copy">
              <span className="eyebrow">WHY IT MATTERS</span>
              <h2>Make prediction markets<br /><span>easier to understand.</span></h2>
              <p>And encourage more people to explore and interact with <strong>DreamDEX Event Contracts.</strong></p>
            </div>
            <div className="impact-window" aria-label="Illustrative DreamDEX event contract discovery card">
              <div className="impact-window-top">
                <span><span className="status-dot" /> LIVE PERSPECTIVES</span>
                <small>FUTURE EXPERIENCE</small>
              </div>
              <div className="impact-question">One market.<br />More ways to see it.</div>
              <div className="impact-models">
                <span className="lime">A</span><span className="violet">F</span><span className="blue">E</span><span className="peach">N</span>
                <div><strong>Transparent models</strong><small>Compared side by side</small></div>
              </div>
              <div className="impact-action">Explore event contracts <ArrowRight size={17} /></div>
            </div>
          </div>
        </section>

        <section className="closing-section" id="closing">
          <div className="closing-grid" />
          <div className="closing-orbit closing-orbit-one" />
          <div className="closing-orbit closing-orbit-two" />
          <div className="closing-content">
            <span className="closing-star"><Sparkles size={34} strokeWidth={1.6} /></span>
            <span className="eyebrow">18 / CLOSING</span>
            <h2>Thank you<br />for watching.</h2>
            <p>Different minds. One market.</p>
            <div className="closing-brand"><Logo /></div>
          </div>
        </section>
      </main>
    </div>
  );
}
