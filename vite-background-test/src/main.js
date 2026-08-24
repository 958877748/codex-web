import './style.css';

let score = 0;
const target = document.querySelector('#target');
const scoreNode = document.querySelector('#score');

target.addEventListener('click', () => {
  score += 1;
  scoreNode.textContent = `分数：${score}`;
  target.style.transform = `translate(${Math.random() * 120 - 60}px, ${Math.random() * 80 - 40}px)`;
});
