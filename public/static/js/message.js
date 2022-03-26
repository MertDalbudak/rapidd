/**
 * 
 * @param {'success'|'warn'|'error'} type Message type
 * @param {string} subject Subject
 * @param {string} text Detailed message
 * @returns {void} Void, returns undefined
 */
function Message(type, subject, text = ""){
    this.element = document.createElement('li');
    this.element.classList.add('msg');
    this.element.classList.add(`msg_${type}`);
    this.element.innerHTML = `<div class="container">
        <div class="msg_symbol"></div>
        <div class="msg_content">
            <h3 class="msg_subject">
                ${subject}
            </h3>
            <div class="msg_text">
                <span>
                    ${text}
                </span>
            </div>
        </div>
        <div class="msg_close">
            <button></button>
        </div>
    </div>
    <div class="fuse-container">
        <div class="fuse ignite"></div>
    </div>`;
    var element = this.element;
    element.querySelector('.fuse').addEventListener('animationend', function(){
        element.classList.add('fade-out');
    });
    element.querySelector('.msg_close button').addEventListener('click', this.hide);
    document.querySelector('#msg_container').appendChild(element);
}

Message.prototype.hide = function(){
    this.element.classList.add('fade-out')
}