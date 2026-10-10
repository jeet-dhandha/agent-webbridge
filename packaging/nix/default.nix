{ lib
, buildNpmPackage
, fetchFromGitHub
}:

buildNpmPackage rec {
  pname = "agent-webbridge";
  version = "1.3.3";

  src = fetchFromGitHub {
    owner = "jeet-dhandha";
    repo = "agent-webbridge";
    rev = "v${version}";
    hash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  };

  npmDepsHash = "sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";

  dontNpmBuild = true;

  meta = with lib; {
    description = "Local Chrome browser automation MCP server with multi-profile and parallel tabs";
    homepage = "https://jeet-dhandha.github.io/agent-webbridge/";
    license = licenses.mit;
    maintainers = [ ];
    mainProgram = "awb";
    platforms = platforms.all;
  };
}
