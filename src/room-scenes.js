// Layered, color-inheriting room scenes match the default room card artwork.
const background = `
  <ellipse cx="182" cy="149" rx="125" ry="11" fill="currentColor" opacity=".08"/>
  <path d="M48 137h264" stroke="currentColor" opacity=".12"/>
  <path d="M59 128V34h65v94" stroke="currentColor" opacity=".22" stroke-width="2"/>
  <path d="M62 37h59v67H62z" fill="white" opacity=".32"/>
  <path d="M92 34v94M59 78h65" stroke="currentColor" opacity=".16" stroke-width="2"/>
  <rect x="175" y="30" width="39" height="29" rx="2" stroke="currentColor" opacity=".23" stroke-width="2"/>
  <path d="m181 52 9-10 6 5 6-6 7 11" stroke="currentColor" opacity=".3"/>
  <path d="M76 139v-27m0 9c-20-2-21-19-21-19 19-1 22 13 21 19Zm0-11c16-4 17-21 17-21-19 2-19 13-17 21Z" stroke="currentColor" opacity=".45" stroke-width="2"/>
  <path d="M65 129h23l-4 17H69z" fill="currentColor" opacity=".36"/>
`;

const scenes = {
  bathroom: `
    <path d="M110 108h132l-9 23q-4 11-17 11h-80q-13 0-17-11z" fill="currentColor" opacity=".29"/>
    <path d="M120 113h112l-6 15q-2 6-10 6h-80q-8 0-10-6z" fill="white" opacity=".32"/>
    <rect x="106" y="103" width="140" height="8" rx="4" fill="currentColor" opacity=".45"/>
    <path d="M125 142v6m101-6v6M126 103V89q0-12 13-12h9v6" stroke="currentColor" stroke-width="3" opacity=".45"/>
    <path d="M160 73h38" stroke="currentColor" stroke-width="3" opacity=".3"/>
    <rect x="166" y="73" width="26" height="23" rx="3" fill="currentColor" opacity=".25"/>
    <path d="M170 90h18" stroke="currentColor" stroke-width="2" opacity=".3"/>
    <circle cx="278" cy="60" r="24" fill="currentColor" opacity=".2"/>
    <circle cx="278" cy="60" r="20" fill="white" opacity=".38"/>
    <path d="m268 59 11-11m-6 20 14-14" stroke="currentColor" stroke-width="2" opacity=".18"/>
    <rect x="248" y="105" width="60" height="37" rx="3" fill="currentColor" opacity=".28"/>
    <rect x="244" y="100" width="68" height="7" rx="3" fill="currentColor" opacity=".45"/>
    <rect x="257" y="94" width="39" height="9" rx="4" fill="white" opacity=".5"/>
    <path d="M276 94v-7q0-8 9-6m-7 29v29m-7-20v8m14-8v8m-31 15v6m48-6v6" stroke="currentColor" stroke-width="2" opacity=".4"/>
    <rect x="299" y="88" width="8" height="12" rx="2" fill="currentColor" opacity=".3"/>
    <path d="M303 88v-4h5" stroke="currentColor" stroke-width="2" opacity=".4"/>
  `,
  garage: `
    <ellipse cx="182" cy="149" rx="125" ry="11" fill="currentColor" opacity=".08"/>
    <path d="M48 144h264" stroke="currentColor" opacity=".12"/>
    <rect x="60" y="31" width="143" height="111" rx="3" fill="currentColor" opacity=".08"/>
    <path d="M57 143V29h149v114M61 60h141M61 81h141M61 102h141M61 123h141" stroke="currentColor" opacity=".24" stroke-width="2"/>
    <path d="M73 40h30v12H73zm43 0h30v12h-30zm43 0h30v12h-30z" fill="white" opacity=".38"/>
    <path d="m91 110 14-29h53l17 29" fill="currentColor" opacity=".29"/>
    <path d="m108 87-9 20h65l-11-20z" fill="white" opacity=".4"/>
    <rect x="82" y="106" width="101" height="30" rx="9" fill="currentColor" opacity=".42"/>
    <path d="M90 134v9m85-9v9" stroke="currentColor" stroke-width="8" opacity=".5"/>
    <path d="M91 117h14m56 0h13M117 127h30" stroke="white" stroke-width="3" opacity=".45"/>
    <rect x="224" y="33" width="76" height="52" rx="3" fill="currentColor" opacity=".16"/>
    <path d="M235 43h54m-54 11h54m-54 11h54m-54 11h54" stroke="currentColor" stroke-dasharray="1 8" opacity=".3" stroke-width="2"/>
    <path d="M240 45v25m-4-25h8m16 1-5 9 5 8 5-8-5-9Zm0 17v10m20-24v24m-5-24h10" stroke="currentColor" opacity=".55" stroke-width="3"/>
    <rect x="217" y="101" width="91" height="8" rx="3" fill="currentColor" opacity=".45"/>
    <path d="M225 109v35m76-35v35" stroke="currentColor" stroke-width="4" opacity=".35"/>
    <rect x="235" y="118" width="54" height="25" rx="3" fill="currentColor" opacity=".28"/>
    <path d="M252 129h20" stroke="white" stroke-width="2" opacity=".45"/>
    <rect x="239" y="88" width="36" height="13" rx="2" fill="currentColor" opacity=".35"/>
    <path d="M250 88v-5h13v5m-7 5h4" stroke="currentColor" stroke-width="2" opacity=".5"/>
  `,
  living: `
    <rect x="119" y="86" width="145" height="48" rx="12" fill="currentColor" opacity=".29"/>
    <rect x="110" y="105" width="163" height="34" rx="9" fill="currentColor" opacity=".42"/>
    <rect x="123" y="91" width="59" height="28" rx="7" fill="white" opacity=".4"/>
    <rect x="190" y="91" width="59" height="28" rx="7" fill="white" opacity=".4"/>
    <path d="M123 139v8m137-8v8" stroke="currentColor" stroke-width="4" opacity=".5"/>
    <path d="M289 139V70m-17 0h34l-8-27h-18z" fill="currentColor" stroke="currentColor" opacity=".36"/>
    <path d="M281 140h17" stroke="currentColor" stroke-width="3" opacity=".45"/>
  `,
  bedroom: `
    <rect x="116" y="73" width="143" height="60" rx="9" fill="currentColor" opacity=".27"/>
    <rect x="120" y="96" width="135" height="40" rx="7" fill="white" opacity=".4"/>
    <rect x="125" y="84" width="54" height="24" rx="7" fill="white" opacity=".5"/>
    <rect x="194" y="84" width="54" height="24" rx="7" fill="white" opacity=".5"/>
    <path d="M114 111h147v30H114z" fill="currentColor" opacity=".38"/>
    <path d="M123 141v7m129-7v7M116 117h143" stroke="currentColor" stroke-width="3" opacity=".3"/>
    <rect x="271" y="111" width="33" height="31" rx="3" fill="currentColor" opacity=".25"/>
    <path d="M284 124h8m-16 18v6m23-6v6M288 110V92" stroke="currentColor" stroke-width="2" opacity=".45"/>
    <path d="M274 92h28l-6-21h-16z" fill="currentColor" opacity=".35"/>
  `,
  kitchen: `
    <rect x="132" y="85" width="171" height="59" rx="3" fill="currentColor" opacity=".28"/>
    <rect x="128" y="82" width="179" height="7" rx="3" fill="currentColor" opacity=".45"/>
    <path d="M184 90v52m61-52v52M145 101h23m28 0h34m27 0h31" stroke="currentColor" stroke-width="2" opacity=".35"/>
    <rect x="192" y="109" width="45" height="27" rx="3" fill="currentColor" opacity=".25"/>
    <rect x="197" y="114" width="35" height="17" rx="2" fill="white" opacity=".3"/>
    <path d="M145 82V69q0-12 13-8" stroke="currentColor" stroke-width="3" opacity=".5"/>
    <path d="M140 84h28m31-5h31" stroke="currentColor" stroke-width="3" opacity=".3"/>
    <rect x="240" y="31" width="63" height="37" rx="3" fill="currentColor" opacity=".22"/>
    <path d="M271 32v35m-7-18v7m14-7v7" stroke="currentColor" stroke-width="2" opacity=".3"/>
    <path d="M271 82V67h18v15" fill="white" opacity=".5"/>
    <path d="m275 67-3-14m8 14 4-16" stroke="currentColor" stroke-width="2" opacity=".4"/>
  `,
  office: `
    <rect x="110" y="102" width="190" height="8" rx="3" fill="currentColor" opacity=".45"/>
    <path d="M120 110v37m169-37v37" stroke="currentColor" stroke-width="5" opacity=".35"/>
    <rect x="157" y="65" width="78" height="35" rx="4" fill="currentColor" opacity=".35"/>
    <rect x="162" y="70" width="68" height="25" rx="2" fill="white" opacity=".4"/>
    <path d="M196 100v4m-16 0h32" stroke="currentColor" stroke-width="3" opacity=".45"/>
    <rect x="170" y="118" width="52" height="22" rx="8" fill="currentColor" opacity=".32"/>
    <path d="M196 140v9m-18 0h36" stroke="currentColor" stroke-width="3" opacity=".4"/>
    <path d="M263 102V72l13-11m-7-4 16 10 3-12-10-6z" stroke="currentColor" fill="currentColor" opacity=".35" stroke-width="2"/>
    <path d="M124 98h24m-24-5h19" stroke="currentColor" stroke-width="4" opacity=".3"/>
    <path d="M244 35h57" stroke="currentColor" stroke-width="3" opacity=".2"/>
    <path d="M251 33V17h9v16m5 0V13h10v20m6 0-3-15 9-2 3 17" stroke="currentColor" fill="currentColor" opacity=".25"/>
  `,
};

export function roomScene(value) {
  if (!Object.hasOwn(scenes, value)) return "";
  return `<svg class="room-art" viewBox="0 0 360 170" fill="none" aria-hidden="true" stroke-linecap="round" stroke-linejoin="round">${value === "garage" ? "" : background}${scenes[value]}</svg>`;
}
