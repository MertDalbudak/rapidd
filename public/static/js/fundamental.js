var IE_version = document.documentMode || false;

function loading(){
    document.body.classList.add('loading');
}

function stopLoading(){
    document.body.classList.remove('loading');
}

function initMessage(e){
    e.querySelector('.fuse').addEventListener('animationend', function(){
        e.classList.add('fade-out');
    });
    e.querySelector('div.msg_close button').addEventListener('click', function(){
        e.classList.add('fade-out');
    });
}

function toggleContextMenu(e){
    e.addEventListener('click', function(){
        e.parentNode.querySelector('.context-menu').classList.toggle('hidden');
    });
}

function hideContextMenu(e){
    document.querySelectorAll('.context-menu ul').forEach(function(ctx_menu){
        var container = ctx_menu.parentNode.parentNode;
        if(e.target == ctx_menu.parentNode || container.contains(e.target) == false)
            ctx_menu.parentNode.classList.add('hidden');
    })
}

function hideNavEvent(e){
    if(document.querySelector("#nav-container").classList.contains("nav-mobile-show")){
        if(e.target == document.querySelector("#nav-container"))
            e.target.classList.remove("nav-mobile-show");
    }
}

function toggleNav(){
    document.querySelector("#nav-container").classList.toggle("nav-mobile-show");
}

function toggleNavLinkCollapse(nav_link){
    nav_link.addEventListener('click', function(e){
        var children = e.target.parentNode.parentNode.querySelector('div.nav-link-children-container');
        children.classList.toggle('hidden');
        if(children.classList.contains('hidden'))
            nav_link.classList.remove('menu-link-children-collapsed');
        else
            nav_link.classList.add('menu-link-children-collapsed');
    });
}

function main(){
    // CHECK IF IE 9 OR LOWER
    if(IE_version != false && IE_version <= 9)
        alert("YOUR BROWSER IS NOT SUPPORTED PLEASE CHANGE TO A MODERN BROWSER");

    // As soon page is ready

    // MESSAGES
    document.querySelectorAll('ul#msg_container li.msg').forEach(initMessage); // HIDE MESSAGE

    document.querySelectorAll('.context-menu-link').forEach(toggleContextMenu);
    document.body.addEventListener('click', hideContextMenu, true);

    // NAV
    document.querySelector("#nav-container").addEventListener('click', hideNavEvent);

    document.querySelectorAll('.nav-link button').forEach(toggleNavLinkCollapse)

    /*document.querySelector("#nav").addEventListener('touchstart', function(e){
        e.target.focus();
    });*/
}

document.addEventListener('DOMContentLoaded', main);