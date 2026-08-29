const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab,.view').forEach(el => el.classList.remove('active'));
  tab.classList.add('active'); document.getElementById(tab.dataset.view).classList.add('active');
  tg?.HapticFeedback?.impactOccurred('light');
}));

document.querySelectorAll('.choices button').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.choices button').forEach(el => el.classList.remove('selected'));
  button.classList.add('selected');
  const correct = button.dataset.correct === 'true';
  const feedback = document.querySelector('.feedback');
  feedback.classList.add('show');
  feedback.innerHTML = correct
    ? '<b>回答准确。</b><br>你抓住了两条主线：击败袁绍、获得北方的战略主动和资源。该节点将在 7 天后复习。'
    : '<b>还差一块关键拼图。</b><br>官渡不是立刻统一全国；重点在于曹操打败北方最强对手，并获得河北的人口、粮食和战略主动。明天会换一种题型带你复习。';
  tg?.HapticFeedback?.notificationOccurred(correct ? 'success' : 'error');
}));

document.querySelector('.go-practice')?.addEventListener('click', () => document.querySelector('[data-view="practice"]').click());
