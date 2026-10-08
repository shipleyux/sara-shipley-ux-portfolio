var yearEl = document.getElementById('year');
if (yearEl) { yearEl.textContent = new Date().getFullYear(); }

var toggle = document.getElementById('navToggle');
var links = document.getElementById('navLinks');
if (toggle && links) {
  toggle.addEventListener('click', function(){
    links.classList.toggle('open');
  });
  links.querySelectorAll('a').forEach(function(a){
    a.addEventListener('click', function(){ links.classList.remove('open'); });
  });
}

var cf = document.getElementById('contactForm');
if (cf) {
  var cfStatus = document.getElementById('cfStatus');
  var cfSubmit = document.getElementById('cfSubmit');
  cf.addEventListener('submit', function(e){
    e.preventDefault();
    cfSubmit.disabled = true;
    cfSubmit.textContent = 'Sending…';
    cfStatus.textContent = '';
    cfStatus.className = 'form-status';

    var data = Object.fromEntries(new FormData(cf));
    fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(data)
    })
    .then(function(res){ return res.json(); })
    .then(function(result){
      if (result.success) {
        cfStatus.textContent = "Thanks, I've got your message and will reply within 24 hours.";
        cfStatus.className = 'form-status success';
        cf.reset();
      } else {
        cfStatus.textContent = 'Something went wrong sending that. Please email shipley.ux@gmail.com instead.';
        cfStatus.className = 'form-status error';
      }
    })
    .catch(function(){
      cfStatus.textContent = 'Something went wrong sending that. Please email shipley.ux@gmail.com instead.';
      cfStatus.className = 'form-status error';
    })
    .finally(function(){
      cfSubmit.disabled = false;
      cfSubmit.textContent = 'Send message';
    });
  });
}
