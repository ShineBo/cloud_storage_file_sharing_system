<#macro content>
    <#-- Use a server-configured app origin. OAuth request parameters never supply this destination. -->
    <#assign home = properties.cloudStorageHomeOrigin!''>
    <#if home?matches(r"(https://[A-Za-z0-9][A-Za-z0-9.-]*|http://(localhost|127\.0\.0\.1|\[::1\]))(:[0-9]{1,5})?/?")>
        <div class="cloud-home">
            <a href="${home?remove_ending('/')}/" referrerpolicy="no-referrer">${msg("cloudStorageBack")}</a>
        </div>
    </#if>
</#macro>
